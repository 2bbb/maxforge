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
  AttrValue,
} from "../core/types.js";
import { expandControlFlow } from "./expander.js";

export function parse(source: string): { ast: ASTNode; errors: CompileError[] } {
  const expanded = expandControlFlow(source);
  if (expanded.errors.length > 0) {
    return {
      ast: { type: "program", statements: [] },
      errors: expanded.errors,
    };
  }

  const errors: CompileError[] = [];
  const lines = expanded.source.split("\n");
  let patchDecl: PatchDecl | undefined;
  const statements: Statement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === "" || line.startsWith("#")) {
      i++;
      continue;
    }

    // patch declaration
    if (line.startsWith("patch ")) {
      const parsed = parsePatchDecl(line, i + 1);
      if (parsed) {
        patchDecl = parsed;
      } else {
        errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Invalid patch declaration`,
          line: i + 1,
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
      const { body, endLine } = parseSubpatcherBody(lines, i + 1, errors);
      statements.push({
        type: "subpatcher_def",
        name,
        subpatcherName,
        body,
        line: i + 1,
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
          line: i + 1,
          pos: positioned.pos,
          attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        } as ObjectDefStmt);
        i++;
        continue;
      }
    }

    // connection: contains -> (only if no = found)
    if (line.includes("->")) {
      const parsed = parseConnection(line, i + 1);
      if (parsed) {
        statements.push(parsed);
      } else {
        errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Invalid connection syntax: ${line}`,
          line: i + 1,
        });
      }
      i++;
      continue;
    }

    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: `Unrecognized statement: ${line}`,
      line: i + 1,
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
  lines: string[],
  startLine: number,
  errors: CompileError[]
): { body: Statement[]; endLine: number } {
  let depth = 1;
  const bodyLines: string[] = [];
  let i = startLine;

  while (i < lines.length && depth > 0) {
    const line = lines[i].trim();
    if (line.endsWith("{")) {
      depth++;
      bodyLines.push(lines[i]);
    } else if (line === "}") {
      depth--;
      if (depth > 0) bodyLines.push(lines[i]);
    } else {
      bodyLines.push(lines[i]);
    }
    i++;
  }

  if (depth > 0) {
    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: "Unclosed subpatcher block",
      line: startLine,
    });
  }

  const { ast, errors: childErrors } = parse(bodyLines.join("\n"));
  for (const error of childErrors) {
    errors.push({
      ...error,
      line: error.line === undefined ? undefined : startLine + error.line,
    });
  }
  return { body: ast.statements, endLine: i - 1 };
}

function parsePositionSuffix(text: string): { text: string; pos?: [number, number] } {
  const posMatch = text.match(/\s+at\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/);
  if (!posMatch) return { text };

  return {
    text: text.substring(0, text.length - posMatch[0].length).trim(),
    pos: [parseInt(posMatch[1]), parseInt(posMatch[2])],
  };
}

function parseAttributes(text: string): { text: string; attrs: Record<string, AttrValue[]> } {
  const attrs: Record<string, AttrValue[]> = {};
  const tokens = tokenizeWithQuotes(text);

  const attrIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith("@")) {
      attrIndices.push(i);
    }
  }

  if (attrIndices.length === 0) {
    return { text, attrs };
  }

  const firstAttr = attrIndices[0];
  const objectTokens = tokens.slice(0, firstAttr);

  for (const startIdx of attrIndices) {
    const key = tokens[startIdx].substring(1);
    const endIdx = attrIndices.find(idx => idx > startIdx) ?? tokens.length;
    const values: AttrValue[] = [];
    for (let j = startIdx + 1; j < endIdx; j++) {
      const t = tokens[j];
      if (/^-?\d+(\.\d+)?$/.test(t)) {
        values.push(parseFloat(t));
      } else {
        values.push(stripQuotes(t));
      }
    }
    if (values.length > 0) {
      attrs[key] = values;
    }
  }

  return { text: objectTokens.join(" "), attrs };
}

function tokenizeWithQuotes(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      tokens.push(text.substring(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !/\s/.test(text[j])) j++;
      tokens.push(text.substring(i, j));
      i = j;
    }
  }
  return tokens;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.substring(1, s.length - 1);
  }
  return s;
}
