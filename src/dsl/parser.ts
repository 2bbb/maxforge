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
      const parsed = parsePatchDecl(line);
      if (parsed) {
        if (patchDecl) {
          errors.push({
            code: ErrorCode.SYNTAX_ERROR,
            message: "Duplicate patch declaration",
            line: current.line,
          });
        } else {
          patchDecl = parsed;
        }
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
      const { attrs, errors: attributeErrors } = parseAttributes(cleanSubpatcherText);
      appendSyntaxErrors(errors, attributeErrors, current.line);
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
        const {
          text: cleanText,
          attrs,
          errors: attributeErrors,
        } = parseAttributes(objectText);
        appendSyntaxErrors(errors, attributeErrors, current.line);
        const specialObjectError = validateSpecialObjectText(cleanText);
        if (specialObjectError) {
          appendSyntaxErrors(errors, [specialObjectError], current.line);
        }
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

function appendSyntaxErrors(
  errors: CompileError[],
  messages: string[],
  line: number
): void {
  for (const message of messages) {
    errors.push({ code: ErrorCode.SYNTAX_ERROR, message, line });
  }
}

function validateSpecialObjectText(text: string): string | null {
  const type = text.match(/^(comment|message)(?:\s|$)/)?.[1];
  if (!type) return null;
  if (/^(?:comment|message)\s+"(?:\\.|[^"\\])*"$/.test(text)) return null;
  return `${type} text must be one quoted string`;
}

function parsePatchDecl(line: string): PatchDecl | null {
  const quotedString = '"(?:\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\\])*"';
  const match = line.match(new RegExp(
    `^patch\\s+(${quotedString})` +
    `(?:\\s*\\|\\s*(${quotedString})?)?` +
    `(?:\\s*\\|\\s*(\\d+)x(\\d+))?$`
  ));
  if (!match) return null;

  let name: string;
  let description: string | undefined;
  try {
    name = JSON.parse(match[1]) as string;
    description = match[2] ? JSON.parse(match[2]) as string : undefined;
  } catch {
    return null;
  }
  if (name.length === 0) return null;

  const result: PatchDecl = { name };
  if (description !== undefined) result.description = description;
  if (match[3] !== undefined && match[4] !== undefined) {
    const width = Number(match[3]);
    const height = Number(match[4]);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }
    result.size = [width, height];
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
