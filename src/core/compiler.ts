import {
  ASTNode,
  Statement,
  ObjectDefStmt,
  ConnectionStmt,
  SubpatcherDefStmt,
  BoxJSON,
  BoxWrapper,
  LineJSON,
  LineWrapper,
  PatcherJSON,
  ObjectDef,
  ObjectDatabase,
  CompileResult,
  CompileError,
  CompileWarning,
  ErrorCode,
  WarningCode,
} from "./types.js";
import { lookupObject, extractQuotedContent } from "./object-db.js";
import { autoLayout } from "./layout.js";

interface CompiledBox {
  id: string;
  name: string;
  maxclass: string;
  numinlets: number;
  numoutlets: number;
  outlettype: string[];
  text?: string;
  comment?: string;
  defaultSize: [number, number];
  patcher?: PatcherJSON["patcher"];
  line: number;
  x: number;
  y: number;
  pinnedPos: boolean;
  attrs?: Record<string, (string | number)[]>;
}

interface CompiledLine {
  sourceId: string;
  sourceOutlet: number;
  destId: string;
  destInlet: number;
}

const RESERVED_ATTR_KEYS = new Set([
  "id",
  "maxclass",
  "numinlets",
  "numoutlets",
  "outlettype",
  "patching_rect",
  "text",
  "patcher",
  "comment",
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

    const firstToken = stmt.objectText.trim().split(/\s+/)[0];

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

    const INLET_OUTLET = new Set(["inlet", "inlet~", "outlet", "outlet~"]);
    const box: CompiledBox = {
      id: nextId(),
      name: stmt.name,
      maxclass: result.maxclass,
      numinlets: result.def.numinlets,
      numoutlets: result.def.numoutlets,
      outlettype: result.def.outlettype,
      defaultSize: result.def.defaultSize,
      text: INLET_OUTLET.has(firstToken) ? undefined : (result.text || undefined),
      comment: INLET_OUTLET.has(firstToken)
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

    const inlets = stmt.body.filter(
      (s): s is ObjectDefStmt =>
        s.type === "object_def" &&
        (/^inlet[~]?\s/.test(s.objectText.trim()) ||
          s.objectText.trim() === "inlet" ||
          s.objectText.trim() === "inlet~")
    );
    const outlets = stmt.body.filter(
      (s): s is ObjectDefStmt =>
        s.type === "object_def" &&
        (/^outlet[~]?\s/.test(s.objectText.trim()) ||
          s.objectText.trim() === "outlet" ||
          s.objectText.trim() === "outlet~")
    );

    const hasAudioInlet = inlets.some((s) =>
      s.objectText.trim().startsWith("inlet~")
    );
    const hasAudioOutlet = outlets.some((s) =>
      s.objectText.trim().startsWith("outlet~")
    );
    const outletType =
      hasAudioOutlet && outlets.length === 1 ? ["signal"] : [""];

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
      outlettype: Array(outlets.length).fill(
        outletType[0]
      ),
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

  const SPECIAL_OBJECTS = new Set(["inlet", "inlet~", "outlet", "outlet~"]);

  function validateAttrs(
    attrs: Record<string, (string | number)[]> | undefined,
    line: number
  ): boolean {
    if (!attrs) return true;
    for (const key of Object.keys(attrs)) {
      if (RESERVED_ATTR_KEYS.has(key)) {
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

function buildPatcherJSON(
  patchDecl: ASTNode["patchDecl"],
  boxes: CompiledBox[],
  lines: CompiledLine[]
): PatcherJSON {
  const boxWrappers: BoxWrapper[] = boxes.map((b) => {
    const box: BoxJSON = {
      id: b.id,
      maxclass: b.maxclass,
      numinlets: b.numinlets,
      numoutlets: b.numoutlets,
      patching_rect: [b.x, b.y, b.defaultSize[0], b.defaultSize[1]],
    };

    if (b.outlettype.length > 0) {
      box.outlettype = b.outlettype;
    }

    const isUINative =
      b.maxclass !== "newobj" &&
      b.maxclass !== "comment" &&
      b.maxclass !== "message" &&
      b.maxclass !== "inlet" &&
      b.maxclass !== "outlet" &&
      b.maxclass !== "inlet~" &&
      b.maxclass !== "outlet~";

    if (b.text !== undefined && !isUINative) {
      box.text = b.text;
    }
    if (b.comment !== undefined) {
      box.comment = b.comment;
    }
    if (b.patcher) {
      box.patcher = b.patcher;
    }

    if (b.attrs) {
      for (const [key, values] of Object.entries(b.attrs)) {
        (box as Record<string, unknown>)[key] = values.length === 1 ? values[0] : values;
      }
    }

    return { box };
  });

  const lineWrappers: LineWrapper[] = lines.map((l) => ({
    patchline: {
      source: [l.sourceId, l.sourceOutlet],
      destination: [l.destId, l.destInlet],
    },
  }));

  return {
    patcher: {
      fileversion: 1,
      appversion: {
        major: 8,
        minor: 6,
        revision: 4,
        processor: "x86",
        platform: "macintel",
      },
      classnamespace: "box",
      rect: [100.0, 100.0, patchDecl?.size?.[0] ?? 640, patchDecl?.size?.[1] ?? 480],
      bglocked: 0,
      openrect: [0.0, 0.0, 0.0, 0.0],
      openinpresentation: 0,
      default_fontsize: 12.0,
      default_fontface: 0,
      default_fontname: "Arial",
      gridonopen: 2,
      gridsize: [15.0, 15.0],
      gridsnaponopen: 0,
      objectsnaponopen: 1,
      statusbarvisible: 2,
      toolbarvisible: 2,
      lefttoolbarpinned: 0,
      toptoolbarpinned: 0,
      righttoolbarpinned: 0,
      bottomtoolbarpinned: 0,
      toolbars_unpinned_last_save: 0,
      tallnewobj: 0,
      boxanimatetime: 200,
      enablehscroll: 1,
      enablevscroll: 1,
      devicewidth: 0.0,
      description: patchDecl?.description ?? "",
      digest: "",
      tags: "",
      style: "",
      subpatcher_template: "",
      assistshowspatchername: 0,
      boxes: boxWrappers,
      lines: lineWrappers,
    },
  };
}
