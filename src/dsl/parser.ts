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

const SPECIAL_OBJECTS = new Set(["inlet", "inlet~", "outlet", "outlet~"]);

export function parse(source: string): { ast: ASTNode; errors: CompileError[] } {
  const errors: CompileError[] = [];
  const lines = source.split("\n");
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

    // subpatcher: name = p subname { ... }
    const subpatcherMatch = line.match(/^(\w+)\s*=\s*p\s+(\w+)\s*\{$/);
    if (subpatcherMatch) {
      const [, name, subpatcherName] = subpatcherMatch;
      const { body, endLine } = parseSubpatcherBody(lines, i + 1, errors);
      statements.push({
        type: "subpatcher_def",
        name,
        subpatcherName,
        body,
        line: i + 1,
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
        let pos: [number, number] | undefined;
        const posMatch = objectText.match(/\s+at\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/);
        if (posMatch) {
          pos = [parseInt(posMatch[1]), parseInt(posMatch[2])];
          objectText = objectText.substring(0, objectText.length - posMatch[0].length).trim();
        }
        statements.push({
          type: "object_def",
          name,
          objectText,
          line: i + 1,
          pos,
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

  const { ast } = parse(bodyLines.join("\n"));
  return { body: ast.statements, endLine: i - 1 };
}
