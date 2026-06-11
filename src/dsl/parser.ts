import {
  ASTNode,
  Statement,
  ObjectDefStmt,
  ConnectionStmt,
  SubpatcherDefStmt,
  PatchDecl,
  PortRef,
  ErrorCode,
  CompileError,
} from "../core/types.js";
import { collectBlock, SourceLine, toSourceLines } from "./blocks.js";
import { expandControlFlow } from "./expander.js";
import { parseAttributes, parsePositionSuffix } from "./object-syntax.js";

export function parse(source: string): { ast: ASTNode; errors: CompileError[] } {
  const expanded = expandControlFlow(source);
  if (expanded.errors.length > 0) {
    return {
      ast: { type: "program", statements: [] },
      errors: expanded.errors,
    };
  }

  const errors: CompileError[] = [];
  const lines = toSourceLines(expanded.source);
  let patchDecl: PatchDecl | undefined;
  const statements: Statement[] = [];
  let i = 0;

  while (i < lines.length) {
    const current = lines[i];
    const line = current.text.trim();

    if (line === "" || line.startsWith("#")) {
      i++;
      continue;
    }

    // patch declaration
    if (line.startsWith("patch ")) {
      const parsed = parsePatchDecl(line, current.line);
      if (parsed) {
        patchDecl = parsed;
      } else {
        errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Invalid patch declaration`,
          line: current.line,
        });
      }
      i++;
      continue;
    }

    // subpatcher: name = p subname [@attrs...] { ... }
    const subpatcherMatch = line.match(/^(\w+)\s*=\s*p\s+(\w+)(.*?)\s*\{$/);
    if (subpatcherMatch) {
      const [, name, subpatcherName, attrText] = subpatcherMatch;
      const { text: cleanSubpatcherText, pos } = parsePositionSuffix(`p ${subpatcherName}${attrText}`);
      const { attrs } = parseAttributes(cleanSubpatcherText);
      const { body, endLine } = parseSubpatcherBody(lines, i + 1, current.line, errors);
      statements.push({
        type: "subpatcher_def",
        name,
        subpatcherName,
        body,
        line: current.line,
        pos,
        attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
      } as SubpatcherDefStmt);
      i = endLine + 1;
      continue;
    }

    // object definition: name = text (check BEFORE connection, since text may contain ->)
    const eqIdx = line.indexOf("=");
    if (eqIdx > 0) {
      const name = line.substring(0, eqIdx).trim();
      let objectText = line.substring(eqIdx + 1).trim();
      if (/^\w+$/.test(name)) {
        const positioned = parsePositionSuffix(objectText);
        objectText = positioned.text;
        const { text: cleanText, attrs } = parseAttributes(objectText);
        statements.push({
          type: "object_def",
          name,
          objectText: cleanText,
          line: current.line,
          pos: positioned.pos,
          attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        } as ObjectDefStmt);
        i++;
        continue;
      }
    }

    // connection: contains -> (only if no = found)
    if (line.includes("->")) {
      const parsed = parseConnection(line, current.line);
      if (parsed) {
        statements.push(parsed);
      } else {
        errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Invalid connection syntax: ${line}`,
          line: current.line,
        });
      }
      i++;
      continue;
    }

    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: `Unrecognized statement: ${line}`,
      line: current.line,
    });
    i++;
  }

  return { ast: { type: "program", patchDecl, statements }, errors };
}

function parsePatchDecl(line: string, lineNum: number): PatchDecl | null {
  const pipeParts = line.split("|").map((s) => s.trim());

  const firstPart = pipeParts[0];
  const nameMatch = firstPart.match(/^patch\s+"(.+)"$/);
  if (!nameMatch) return null;

  const result: PatchDecl = { name: nameMatch[1] };

  if (pipeParts.length > 1 && pipeParts[1]) {
    const descMatch = pipeParts[1].match(/^"(.*)"$/);
    if (descMatch) result.description = descMatch[1];
    else result.description = pipeParts[1];
  }

  if (pipeParts.length > 2 && pipeParts[2]) {
    const sizeMatch = pipeParts[2].match(/^(\d+)x(\d+)$/);
    if (sizeMatch) {
      result.size = [parseInt(sizeMatch[1]), parseInt(sizeMatch[2])];
    }
  }

  return result;
}

function parseConnection(line: string, lineNum: number): ConnectionStmt | null {
  const parts = line.split("->").map((s) => s.trim());
  if (parts.length < 2) return null;

  const refs: PortRef[] = [];
  for (const part of parts) {
    const ref = parsePortRef(part);
    if (!ref) return null;
    refs.push(ref);
  }

  return { type: "connection", refs, line: lineNum };
}

function parsePortRef(text: string): PortRef | null {
  const match = text.match(/^(\w+)(?:\[(\d+)(?::(\d+))?\])?$/);
  if (!match) return null;

  const name = match[1];
  const outlet = match[2] ? parseInt(match[2]) : undefined;
  const inlet = match[3] ? parseInt(match[3]) : undefined;

  return { name, outlet, inlet };
}

function parseSubpatcherBody(
  lines: SourceLine[],
  startIndex: number,
  openLine: number,
  errors: CompileError[]
): { body: Statement[]; endLine: number } {
  const block = collectBlock(lines, startIndex);

  if (!block.closed) {
    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: "Unclosed subpatcher block",
      line: openLine,
    });
  }

  const { ast, errors: childErrors } = parse(block.lines.map((line) => line.text).join("\n"));
  for (const error of childErrors) {
    errors.push({
      ...error,
      line: error.line === undefined ? undefined : block.lines[error.line - 1]?.line,
    });
  }
  return { body: ast.statements, endLine: block.nextIndex - 1 };
}
