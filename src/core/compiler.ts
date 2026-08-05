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
} from "./types.js";
import { lookupObject } from "./object-db.js";
import { autoLayout } from "./layout.js";
import { isReservedAttributeKey } from "./attributes.js";
import { CompiledBox, CompiledLine } from "./compiled-model.js";
import { compileConnectionPair } from "./connection-compiler.js";
import { buildPatcherJSON } from "./patcher-json.js";
import {
  firstObjectToken,
  INLET_OBJECT_TYPES,
  isPortObjectStmt,
  isPortObjectToken,
  OUTLET_OBJECT_TYPES,
  parsePortObject,
} from "./port-objects.js";

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

  function boxId(name: string): string {
    return `obj-${name}`;
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

    if (isPortObjectToken(firstToken) && !isSubpatcher) {
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

    const portSpec = parsePortObject(stmt.objectText);
    const isPortObject = portSpec !== null;
    const box: CompiledBox = {
      id: boxId(stmt.name),
      name: stmt.name,
      maxclass: result.maxclass,
      numinlets: result.def.numinlets,
      numoutlets: result.def.numoutlets,
      outlettype: portSpec?.kind === "inlet" && portSpec.signal
        ? ["signal"]
        : result.def.outlettype,
      dynamicPorts: result.def.dynamicPorts,
      defaultSize: result.def.defaultSize,
      text: isPortObject ? undefined : (result.text || undefined),
      comment: portSpec?.comment,
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
      const result = compileConnectionPair(
        stmt.refs[i],
        stmt.refs[i + 1],
        stmt.line,
        nameMap,
        lines
      );
      errors.push(...result.errors);
      if (result.warning) warnings.push(result.warning);
      if (result.line) lines.push(result.line);
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
    const outletTypes = outlets.map((outlet) =>
      parsePortObject(outlet.objectText)?.signal ? "signal" : ""
    );

    if (inlets.length === 0 && outlets.length === 0) {
      errors.push({
        code: ErrorCode.EMPTY_SUBPATCHER,
        message: `Subpatcher "${stmt.name}" has no inlets or outlets`,
        line: stmt.line,
      });
      return;
    }

    const box: CompiledBox = {
      id: boxId(stmt.name),
      name: stmt.name,
      maxclass: "newobj",
      numinlets: inlets.length,
      numoutlets: outlets.length,
      outlettype: outletTypes,
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
