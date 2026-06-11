import {
  ASTNode,
  Statement,
  ObjectDefStmt,
  ConnectionStmt,
  SubpatcherDefStmt,
  ObjectDatabase,
  CompileResult,
  CompileError,
  CompileWarning,
  ErrorCode,
  WarningCode,
} from "./types.js";
import { lookupObject, extractQuotedContent } from "./object-db.js";
import { autoLayout } from "./layout.js";
import { isReservedAttributeKey } from "./attributes.js";
import { CompiledBox, CompiledLine } from "./compiled-model.js";
import { buildPatcherJSON } from "./patcher-json.js";

const INLET_OBJECT_TYPES = ["inlet", "inlet~"] as const;
const OUTLET_OBJECT_TYPES = ["outlet", "outlet~"] as const;
const SPECIAL_OBJECTS = new Set<string>([
  ...INLET_OBJECT_TYPES,
  ...OUTLET_OBJECT_TYPES,
]);

export function compile(
  ast: ASTNode,
  database: ObjectDatabase,
  allowUnknown = false,
  isSubpatcher = false
): CompileResult {
  const errors: CompileError[] = [];
  const warnings: CompileWarning[] = [];
  const boxes: CompiledBox[] = [];
  const lines: CompiledLine[] = [];
  const nameMap = new Map<string, CompiledBox>();
  let idCounter = 1;

  function nextId(): string {
    return `obj-${idCounter++}`;
  }

  function compileStatements(stmts: Statement[], isSubpatcher: boolean) {
    for (const stmt of stmts) {
      if (stmt.type === "object_def") {
        compileObjectDef(stmt, isSubpatcher);
      } else if (stmt.type === "connection") {
        compileConnection(stmt);
      } else if (stmt.type === "subpatcher_def") {
        compileSubpatcher(stmt);
      }
    }
  }

  function compileObjectDef(stmt: ObjectDefStmt, isSubpatcher: boolean) {
    if (nameMap.has(stmt.name)) {
      errors.push({
        code: ErrorCode.DUPLICATE_NAME,
        message: `Duplicate name: "${stmt.name}"`,
        line: stmt.line,
      });
      return;
    }

    const firstToken = firstObjectToken(stmt.objectText);

    if (SPECIAL_OBJECTS.has(firstToken) && !isSubpatcher) {
      errors.push({
        code: ErrorCode.INLET_OUTSIDE_SUBPATCHER,
        message: `${firstToken} can only be used inside a subpatcher`,
        line: stmt.line,
      });
      return;
    }

    const result = lookupObject(stmt.objectText, database, allowUnknown);
    if (!result) {
      errors.push({
        code: ErrorCode.UNKNOWN_OBJECT,
        message: `Unknown object type: "${firstToken}"`,
        line: stmt.line,
      });
      return;
    }

    if (!validateAttrs(stmt.attrs, stmt.line)) return;

    const isPortObject = SPECIAL_OBJECTS.has(firstToken);
    const box: CompiledBox = {
      id: nextId(),
      name: stmt.name,
      maxclass: result.maxclass,
      numinlets: result.def.numinlets,
      numoutlets: result.def.numoutlets,
      outlettype: result.def.outlettype,
      defaultSize: result.def.defaultSize,
      text: isPortObject ? undefined : (result.text || undefined),
      comment: isPortObject
        ? extractQuotedContent(stmt.objectText) || undefined
        : undefined,
      line: stmt.line,
      x: stmt.pos?.[0] ?? 0,
      y: stmt.pos?.[1] ?? 0,
      pinnedPos: stmt.pos !== undefined,
      attrs: stmt.attrs,
    };

    boxes.push(box);
    nameMap.set(stmt.name, box);
  }

  function compileConnection(stmt: ConnectionStmt) {
    for (let i = 0; i < stmt.refs.length - 1; i++) {
      const src = stmt.refs[i];
      const dst = stmt.refs[i + 1];

      const srcBox = nameMap.get(src.name);
      const dstBox = nameMap.get(dst.name);

      if (!srcBox) {
        errors.push({
          code: ErrorCode.UNDEFINED_REF,
          message: `Undefined reference: "${src.name}"`,
          line: stmt.line,
        });
        continue;
      }
      if (!dstBox) {
        errors.push({
          code: ErrorCode.UNDEFINED_REF,
          message: `Undefined reference: "${dst.name}"`,
          line: stmt.line,
        });
        continue;
      }

      const outletIdx = src.outlet ?? 0;
      const inletIdx = dst.inlet ?? dst.outlet ?? 0;

      if (outletIdx >= srcBox.numoutlets) {
        errors.push({
          code: ErrorCode.OUTLET_OUT_OF_RANGE,
          message: `Outlet index out of range: ${src.name}[${outletIdx}] has ${srcBox.numoutlets} outlets`,
          line: stmt.line,
        });
        continue;
      }
      if (inletIdx >= dstBox.numinlets) {
        errors.push({
          code: ErrorCode.INLET_OUT_OF_RANGE,
          message: `Inlet index out of range: ${dst.name}[${inletIdx}] has ${dstBox.numinlets} inlets`,
          line: stmt.line,
        });
        continue;
      }

      const isDup = lines.some(
        (l) =>
          l.sourceId === srcBox.id &&
          l.sourceOutlet === outletIdx &&
          l.destId === dstBox.id &&
          l.destInlet === inletIdx
      );

      if (isDup) {
        warnings.push({
          code: WarningCode.DUPLICATE_CONNECTION,
          message: `Duplicate connection: ${src.name}[${outletIdx}] -> ${dst.name}[${inletIdx}]`,
          line: stmt.line,
        });
        continue;
      }

      lines.push({
        sourceId: srcBox.id,
        sourceOutlet: outletIdx,
        destId: dstBox.id,
        destInlet: inletIdx,
      });
    }
  }

  function compileSubpatcher(stmt: SubpatcherDefStmt) {
    if (nameMap.has(stmt.name)) {
      errors.push({
        code: ErrorCode.DUPLICATE_NAME,
        message: `Duplicate name: "${stmt.name}"`,
        line: stmt.line,
      });
      return;
    }

    if (!validateAttrs(stmt.attrs, stmt.line)) return;

    const subResult = compile(
      {
        type: "program",
        patchDecl: undefined,
        statements: stmt.body,
      },
      database,
      allowUnknown,
      true
    );

    if (!subResult.success) {
      errors.push(...subResult.errors);
      return;
    }

    const inlets = stmt.body.filter((s): s is ObjectDefStmt =>
      isPortObjectStmt(s, INLET_OBJECT_TYPES)
    );
    const outlets = stmt.body.filter((s): s is ObjectDefStmt =>
      isPortObjectStmt(s, OUTLET_OBJECT_TYPES)
    );
    const outletType =
      outlets.length === 1 && isObjectTextKind(outlets[0].objectText, "outlet~")
        ? "signal"
        : "";

    if (inlets.length === 0 && outlets.length === 0) {
      errors.push({
        code: ErrorCode.EMPTY_SUBPATCHER,
        message: `Subpatcher "${stmt.name}" has no inlets or outlets`,
        line: stmt.line,
      });
      return;
    }

    const box: CompiledBox = {
      id: nextId(),
      name: stmt.name,
      maxclass: "newobj",
      numinlets: inlets.length,
      numoutlets: outlets.length,
      outlettype: Array(outlets.length).fill(outletType),
      defaultSize: [100, 22],
      text: `p ${stmt.subpatcherName}`,
      line: stmt.line,
      patcher: subResult.output!.patcher,
      x: stmt.pos?.[0] ?? 0,
      y: stmt.pos?.[1] ?? 0,
      pinnedPos: stmt.pos !== undefined,
      attrs: stmt.attrs,
    };

    boxes.push(box);
    nameMap.set(stmt.name, box);
    warnings.push(...subResult.warnings);
  }

  function validateAttrs(
    attrs: Record<string, (string | number)[]> | undefined,
    line: number
  ): boolean {
    if (!attrs) return true;
    for (const key of Object.keys(attrs)) {
      if (isReservedAttributeKey(key)) {
        errors.push({
          code: ErrorCode.RESERVED_ATTRIBUTE,
          message: `Reserved attribute cannot be set with @${key}`,
          line,
        });
        return false;
      }
    }
    return true;
  }

  compileStatements(ast.statements, isSubpatcher);

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  autoLayout(boxes, lines);

  const patcherJSON = buildPatcherJSON(
    ast.patchDecl,
    boxes,
    lines
  );

  return { success: true, errors: [], warnings, output: patcherJSON };
}

function firstObjectToken(objectText: string): string {
  return objectText.trim().split(/\s+/)[0] ?? "";
}

function isPortObjectStmt(
  stmt: Statement,
  objectTypes: readonly string[]
): stmt is ObjectDefStmt {
  return stmt.type === "object_def" && objectTypes.some((type) =>
    isObjectTextKind(stmt.objectText, type)
  );
}

function isObjectTextKind(objectText: string, objectType: string): boolean {
  const trimmed = objectText.trim();
  return trimmed === objectType || trimmed.startsWith(`${objectType} `);
}
