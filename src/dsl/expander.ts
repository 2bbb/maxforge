import { CompileError, ErrorCode } from "../core/types.js";

interface SourceLine {
  text: string;
  line: number;
}

interface ExpandResult {
  source: string;
  errors: CompileError[];
}

const FOR_RE = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\.\.(.+?)(?:\s+step\s+(.+?))?\s*\{$/;
const IF_RE = /^if\s+(.+)\s*\{$/;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;

export function expandControlFlow(source: string): ExpandResult {
  const lines = source.split("\n").map((text, index) => ({ text, line: index + 1 }));
  const errors: CompileError[] = [];
  const result = expandBlock(lines, 0, new Map(), false, errors);

  if (result.closed) {
    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: "Unexpected closing brace",
      line: result.closeLine,
    });
  }

  return { source: result.lines.join("\n"), errors };
}

interface BlockResult {
  lines: string[];
  nextIndex: number;
  closed: boolean;
  closeLine?: number;
}

function expandBlock(
  sourceLines: SourceLine[],
  startIndex: number,
  env: Map<string, number>,
  allowClose: boolean,
  errors: CompileError[]
): BlockResult {
  const output: string[] = [];
  let i = startIndex;

  while (i < sourceLines.length) {
    const current = sourceLines[i];
    const trimmed = current.text.trim();

    if (trimmed === "}") {
      if (!allowClose) {
        return { lines: output, nextIndex: i + 1, closed: true, closeLine: current.line };
      }
      return { lines: output, nextIndex: i + 1, closed: true, closeLine: current.line };
    }

    const forMatch = trimmed.match(FOR_RE);
    if (forMatch) {
      const body = collectRawBlock(sourceLines, i + 1);
      if (!body.closed) {
        errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Unclosed for block starting at line ${current.line}`,
          line: current.line,
        });
        return { lines: output, nextIndex: sourceLines.length, closed: false };
      }

      const [, varName, startExpr, endExpr, stepExpr] = forMatch;
      const range = evalRange(startExpr, endExpr, stepExpr, env, current.line, errors);
      if (range) {
        for (const value of range) {
          const innerEnv = new Map(env);
          innerEnv.set(varName, value);
          const expanded = expandBlock(body.lines, 0, innerEnv, false, errors);
          output.push(...expanded.lines);
        }
      }

      i = body.nextIndex;
      continue;
    }

    const ifMatch = trimmed.match(IF_RE);
    if (ifMatch) {
      const body = collectRawBlock(sourceLines, i + 1);
      if (!body.closed) {
        errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Unclosed if block starting at line ${current.line}`,
          line: current.line,
        });
        return { lines: output, nextIndex: sourceLines.length, closed: false };
      }

      const condition = evalExpression(ifMatch[1], env, current.line, errors);
      if (condition !== null && condition !== 0) {
        const expanded = expandBlock(body.lines, 0, env, false, errors);
        output.push(...expanded.lines);
      }

      i = body.nextIndex;
      continue;
    }

    if (trimmed.endsWith("{")) {
      const header = interpolateLine(current.text, env, current.line, errors);
      output.push(header);

      const body = expandBlock(sourceLines, i + 1, env, true, errors);
      output.push(...body.lines);
      if (!body.closed) {
        errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Unclosed block starting at line ${current.line}`,
          line: current.line,
        });
        return { lines: output, nextIndex: sourceLines.length, closed: false };
      }
      output.push("}");
      i = body.nextIndex;
      continue;
    }

    output.push(interpolateLine(current.text, env, current.line, errors));
    i++;
  }

  return { lines: output, nextIndex: i, closed: false };
}

function collectRawBlock(sourceLines: SourceLine[], startIndex: number): {
  lines: SourceLine[];
  nextIndex: number;
  closed: boolean;
} {
  const lines: SourceLine[] = [];
  let depth = 1;
  let i = startIndex;

  while (i < sourceLines.length) {
    const current = sourceLines[i];
    const trimmed = current.text.trim();

    if (trimmed.endsWith("{")) {
      depth++;
      lines.push(current);
    } else if (trimmed === "}") {
      depth--;
      if (depth === 0) {
        return { lines, nextIndex: i + 1, closed: true };
      }
      lines.push(current);
    } else {
      lines.push(current);
    }
    i++;
  }

  return { lines, nextIndex: i, closed: false };
}

function evalRange(
  startExpr: string,
  endExpr: string,
  stepExpr: string | undefined,
  env: Map<string, number>,
  line: number,
  errors: CompileError[]
): number[] | null {
  const start = evalExpression(startExpr, env, line, errors);
  const end = evalExpression(endExpr, env, line, errors);
  const explicitStep = stepExpr ? evalExpression(stepExpr, env, line, errors) : null;

  if (start === null || end === null || (stepExpr && explicitStep === null)) return null;

  const step = explicitStep ?? (start <= end ? 1 : -1);
  if (step === 0) {
    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: "for loop step cannot be 0",
      line,
    });
    return null;
  }

  const values: number[] = [];
  if (step > 0) {
    for (let v = start; v <= end; v += step) values.push(v);
  } else {
    for (let v = start; v >= end; v += step) values.push(v);
  }
  return values;
}

function interpolateLine(
  lineText: string,
  env: Map<string, number>,
  line: number,
  errors: CompileError[]
): string {
  return lineText.replace(INTERPOLATION_RE, (_match, expr: string) => {
    const value = evalExpression(expr, env, line, errors);
    return value === null ? "" : formatNumber(value);
  });
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function evalExpression(
  expr: string,
  env: Map<string, number>,
  line: number,
  errors: CompileError[]
): number | null {
  try {
    const parser = new ExpressionParser(expr, env);
    return parser.parse();
  } catch (error) {
    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: error instanceof Error ? error.message : `Invalid expression: ${expr}`,
      line,
    });
    return null;
  }
}

type Token =
  | { type: "number"; value: number }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "paren"; value: "(" | ")" }
  | { type: "eof" };

class ExpressionParser {
  private tokens: Token[];
  private pos = 0;

  constructor(private readonly input: string, private readonly env: Map<string, number>) {
    this.tokens = tokenize(input);
  }

  parse(): number {
    const value = this.parseComparison();
    if (this.peek().type !== "eof") {
      throw new Error(`Invalid expression: ${this.input}`);
    }
    return value;
  }

  private parseComparison(): number {
    let left = this.parseAdditive();
    const tok = this.peek();
    if (tok.type === "op" && ["==", "!=", "<=", ">=", "<", ">"].includes(tok.value)) {
      this.next();
      const right = this.parseAdditive();
      switch (tok.value) {
        case "==": left = left === right ? 1 : 0; break;
        case "!=": left = left !== right ? 1 : 0; break;
        case "<=": left = left <= right ? 1 : 0; break;
        case ">=": left = left >= right ? 1 : 0; break;
        case "<": left = left < right ? 1 : 0; break;
        case ">": left = left > right ? 1 : 0; break;
      }
    }
    return left;
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative();
    while (true) {
      const tok = this.peek();
      if (tok.type !== "op" || (tok.value !== "+" && tok.value !== "-")) break;
      this.next();
      const rhs = this.parseMultiplicative();
      value = tok.value === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseMultiplicative(): number {
    let value = this.parseUnary();
    while (true) {
      const tok = this.peek();
      if (tok.type !== "op" || (tok.value !== "*" && tok.value !== "/")) break;
      this.next();
      const rhs = this.parseUnary();
      value = tok.value === "*" ? value * rhs : value / rhs;
    }
    return value;
  }

  private parseUnary(): number {
    const tok = this.peek();
    if (tok.type === "op" && (tok.value === "+" || tok.value === "-")) {
      this.next();
      const value = this.parseUnary();
      return tok.value === "-" ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const tok = this.next();
    if (tok.type === "number") return tok.value;
    if (tok.type === "ident") {
      const value = this.env.get(tok.value);
      if (value === undefined) throw new Error(`Undefined variable in expression: ${tok.value}`);
      return value;
    }
    if (tok.type === "paren" && tok.value === "(") {
      const value = this.parseComparison();
      const close = this.next();
      if (close.type !== "paren" || close.value !== ")") {
        throw new Error(`Unclosed parenthesis in expression: ${this.input}`);
      }
      return value;
    }
    throw new Error(`Invalid expression: ${this.input}`);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    const two = input.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }

    if (["+", "-", "*", "/", "<", ">"].includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i++;
      continue;
    }

    const numMatch = input.slice(i).match(/^\d+(?:\.\d+)?/);
    if (numMatch) {
      tokens.push({ type: "number", value: parseFloat(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }

    const identMatch = input.slice(i).match(/^[A-Za-z_]\w*/);
    if (identMatch) {
      tokens.push({ type: "ident", value: identMatch[0] });
      i += identMatch[0].length;
      continue;
    }

    throw new Error(`Invalid expression token near: ${input.slice(i)}`);
  }

  tokens.push({ type: "eof" });
  return tokens;
}
