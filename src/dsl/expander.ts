import { CompileError, ErrorCode } from "../core/types.js";
import { collectBlock, SourceLine, toSourceLines } from "./blocks.js";
import { evaluateExpression } from "./expression.js";

interface ExpandResult {
  source: string;
  errors: CompileError[];
}

export interface ExpansionLimits {
  readonly maxExpandedLines?: number;
  readonly maxLoopIterations?: number;
}

interface ExpansionState {
  readonly errors: CompileError[];
  readonly maxExpandedLines: number;
  readonly maxLoopIterations: number;
  expandedLines: number;
  exhausted: boolean;
}

export const DEFAULT_MAX_EXPANDED_LINES = 100_000;
export const DEFAULT_MAX_LOOP_ITERATIONS = 100_000;

const FOR_RE = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\.\.(.+?)(?:\s+step\s+(.+?))?\s*\{$/;
const IF_RE = /^if\s+(.+)\s*\{$/;
const ELSE_RE = /^(?:}\s*)?else\s*\{$/;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;

export function expandControlFlow(
  source: string,
  limits: ExpansionLimits = {}
): ExpandResult {
  const lines = toSourceLines(source);
  const errors: CompileError[] = [];
  const state: ExpansionState = {
    errors,
    maxExpandedLines: positiveIntegerLimit(
      limits.maxExpandedLines,
      DEFAULT_MAX_EXPANDED_LINES,
      "maxExpandedLines"
    ),
    maxLoopIterations: positiveIntegerLimit(
      limits.maxLoopIterations,
      DEFAULT_MAX_LOOP_ITERATIONS,
      "maxLoopIterations"
    ),
    expandedLines: 0,
    exhausted: false,
  };
  const result = expandBlock(lines, 0, new Map(), state);

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
  state: ExpansionState
): BlockResult {
  const output: string[] = [];
  let i = startIndex;

  while (i < sourceLines.length && !state.exhausted) {
    const current = sourceLines[i];
    const trimmed = current.text.trim();

    if (trimmed === "}") {
      return { lines: output, nextIndex: i + 1, closed: true, closeLine: current.line };
    }

    const forMatch = trimmed.match(FOR_RE);
    if (forMatch) {
      const body = collectBlock(sourceLines, i + 1);
      if (!body.closed) {
        state.errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Unclosed for block starting at line ${current.line}`,
          line: current.line,
        });
        return { lines: output, nextIndex: sourceLines.length, closed: false };
      }

      const [, varName, startExpr, endExpr, stepExpr] = forMatch;
      const range = evalRange(
        startExpr,
        endExpr,
        stepExpr,
        env,
        current.line,
        state
      );
      if (range) {
        for (const value of range) {
          if (state.exhausted) break;
          const innerEnv = new Map(env);
          innerEnv.set(varName, value);
          const expanded = expandBlock(body.lines, 0, innerEnv, state);
          output.push(...expanded.lines);
        }
      }

      i = body.nextIndex;
      continue;
    }

    const ifMatch = trimmed.match(IF_RE);
    if (ifMatch) {
      const body = collectBlock(sourceLines, i + 1);
      if (!body.closed) {
        state.errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Unclosed if block starting at line ${current.line}`,
          line: current.line,
        });
        return { lines: output, nextIndex: sourceLines.length, closed: false };
      }

      const condition = evalExpression(ifMatch[1], env, current.line, state.errors);
      let nextIndex = body.nextIndex;
      let elseBody: ReturnType<typeof collectBlock> | undefined;
      const maybeElse = sourceLines[nextIndex];
      if (maybeElse && ELSE_RE.test(maybeElse.text.trim())) {
        elseBody = collectBlock(sourceLines, nextIndex + 1);
        if (!elseBody.closed) {
          state.errors.push({
            code: ErrorCode.SYNTAX_ERROR,
            message: `Unclosed else block starting at line ${maybeElse.line}`,
            line: maybeElse.line,
          });
          return { lines: output, nextIndex: sourceLines.length, closed: false };
        }
        nextIndex = elseBody.nextIndex;
      }

      if (condition !== null && condition !== 0) {
        const expanded = expandBlock(body.lines, 0, env, state);
        output.push(...expanded.lines);
      } else if (condition !== null && elseBody) {
        const expanded = expandBlock(elseBody.lines, 0, env, state);
        output.push(...expanded.lines);
      }

      i = nextIndex;
      continue;
    }

    if (ELSE_RE.test(trimmed)) {
      state.errors.push({
        code: ErrorCode.SYNTAX_ERROR,
        message: "else must immediately follow an if block",
        line: current.line,
      });
      return { lines: output, nextIndex: sourceLines.length, closed: false };
    }

    if (trimmed.endsWith("{")) {
      const header = interpolateLine(current.text, env, current.line, state.errors);
      appendLines(output, [header], current.line, state);

      const body = expandBlock(sourceLines, i + 1, env, state);
      output.push(...body.lines);
      if (!body.closed) {
        state.errors.push({
          code: ErrorCode.SYNTAX_ERROR,
          message: `Unclosed block starting at line ${current.line}`,
          line: current.line,
        });
        return { lines: output, nextIndex: sourceLines.length, closed: false };
      }
      appendLines(output, ["}"], current.line, state);
      i = body.nextIndex;
      continue;
    }

    appendLines(
      output,
      [interpolateLine(current.text, env, current.line, state.errors)],
      current.line,
      state
    );
    i++;
  }

  return { lines: output, nextIndex: i, closed: false };
}

function evalRange(
  startExpr: string,
  endExpr: string,
  stepExpr: string | undefined,
  env: Map<string, number>,
  line: number,
  state: ExpansionState
): number[] | null {
  const start = evalExpression(startExpr, env, line, state.errors);
  const end = evalExpression(endExpr, env, line, state.errors);
  const explicitStep = stepExpr
    ? evalExpression(stepExpr, env, line, state.errors)
    : null;

  if (start === null || end === null || (stepExpr && explicitStep === null)) return null;

  const step = explicitStep ?? (start <= end ? 1 : -1);
  if (step === 0) {
    state.errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: "for loop step cannot be 0",
      line,
    });
    return null;
  }
  if ((start < end && step < 0) || (end < start && 0 < step)) {
    state.errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: "for loop step does not advance toward the range end",
      line,
    });
    return null;
  }

  const values: number[] = [];
  if (step > 0) {
    for (let value = start; value <= end; value += step) {
      if (!appendRangeValue(values, value, step, line, state)) return null;
    }
  } else {
    for (let value = start; value >= end; value += step) {
      if (!appendRangeValue(values, value, step, line, state)) return null;
    }
  }
  return values;
}

function appendRangeValue(
  values: number[],
  value: number,
  step: number,
  line: number,
  state: ExpansionState
): boolean {
  if (state.maxLoopIterations <= values.length) {
    state.errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: `for loop exceeds ${state.maxLoopIterations} iterations`,
      line,
    });
    return false;
  }
  if (value + step === value) {
    state.errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: "for loop step is too small to advance the range",
      line,
    });
    return false;
  }
  values.push(value);
  return true;
}

function appendLines(
  output: string[],
  lines: readonly string[],
  line: number,
  state: ExpansionState
): void {
  if (state.exhausted || lines.length === 0) return;
  if (state.maxExpandedLines < state.expandedLines + lines.length) {
    state.errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: `expanded source exceeds ${state.maxExpandedLines} lines`,
      line,
    });
    state.exhausted = true;
    return;
  }
  output.push(...lines);
  state.expandedLines += lines.length;
}

function positiveIntegerLimit(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
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
    return evaluateExpression(expr, env);
  } catch (error) {
    errors.push({
      code: ErrorCode.SYNTAX_ERROR,
      message: error instanceof Error ? error.message : `Invalid expression: ${expr}`,
      line,
    });
    return null;
  }
}
