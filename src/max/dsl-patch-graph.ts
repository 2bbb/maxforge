import { compile } from "../core/compiler.js";
import { decompile } from "../core/decompiler.js";
import { buildPatcherJSON } from "../core/patcher-json.js";
import type {
  ASTNode,
  CompileError,
  CompileWarning,
  ObjectDatabase,
} from "../core/types.js";
import { ErrorCode } from "../core/types.js";
import { parse } from "../dsl/parser.js";
import {
  compiledPatcherToPatchGraph,
  isValidPatchScope,
  type PatchGraph,
  type PatchGraphNode,
} from "./patch-graph.js";

export interface PatchGraphCompileResult {
  success: boolean;
  errors: CompileError[];
  warnings: CompileWarning[];
  graph?: PatchGraph;
}

export function compileDslToPatchGraph(
  source: string,
  database: ObjectDatabase,
  scope: string,
  allowUnknown = false
): PatchGraphCompileResult {
  if (!isValidPatchScope(scope)) {
    return {
      success: false,
      errors: [{
        code: ErrorCode.SYNTAX_ERROR,
        message: `Invalid maxforge scope: "${scope}". Use letters, digits, and underscores.`,
      }],
      warnings: [],
    };
  }

  const { ast, errors: parseErrors } = parse(source);
  if (parseErrors.length > 0) {
    return { success: false, errors: parseErrors, warnings: [] };
  }

  const varNameError = findReservedVarName(ast);
  if (varNameError) {
    return { success: false, errors: [varNameError], warnings: [] };
  }

  const result = compile(ast, database, allowUnknown);
  if (!result.success) {
    return {
      success: false,
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  return {
    success: true,
    errors: [],
    warnings: result.warnings,
    graph: compiledPatcherToPatchGraph(result.output!, scope),
  };
}

/** Serialize a managed graph into explicit, round-trip-oriented DSL. */
export function patchGraphToDsl(graph: PatchGraph): string {
  return decompile(
    { patcher: patchGraphNodeToPatcher(graph.patcher) },
    [],
    {
      boxName: (box) => managedDslName(box.id),
      includeBoxSize: true,
    }
  );
}

function patchGraphNodeToPatcher(
  node: PatchGraphNode
): ReturnType<typeof buildPatcherJSON>["patcher"] {
  const empty = buildPatcherJSON(undefined, [], []).patcher;
  return {
    ...empty,
    boxes: node.boxes.map((box) => ({
      box: {
        ...box.attributes,
        id: box.id,
        maxclass: box.maxclass,
        numinlets: box.numinlets,
        numoutlets: box.numoutlets,
        outlettype: [...box.outlettype],
        patching_rect: [...box.patchingRect],
        ...(box.text !== undefined ? { text: box.text } : {}),
        ...(box.comment !== undefined ? { comment: box.comment } : {}),
        ...(box.patcher
          ? { patcher: patchGraphNodeToPatcher(box.patcher) }
          : {}),
      },
    })),
    lines: node.connections.map((connection) => ({
      patchline: {
        source: [connection.source.id, connection.source.port],
        destination: [connection.destination.id, connection.destination.port],
      },
    })),
  };
}

function managedDslName(id: string): string {
  const match = id.match(/^obj-(\w+)$/);
  if (!match) throw new Error(`Cannot serialize invalid managed box id "${id}"`);
  return match[1];
}

function findReservedVarName(ast: ASTNode): CompileError | null {
  for (const statement of ast.statements) {
    if (statement.type !== "connection" && statement.attrs?.varname) {
      return {
        code: ErrorCode.RESERVED_ATTRIBUTE,
        message: "Managed patch graphs reserve @varname for stable object identity",
        line: statement.line,
      };
    }
    if (statement.type === "subpatcher_def") {
      const nested = findReservedVarName({
        type: "program",
        statements: statement.body,
      });
      if (nested) return nested;
    }
  }
  return null;
}
