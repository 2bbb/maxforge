type Token =
  | { type: "number"; value: number }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "paren"; value: "(" | ")" }
  | { type: "eof" };

export function evaluateExpression(expr: string, env: Map<string, number>): number {
  const parser = new ExpressionParser(expr, env);
  return parser.parse();
}

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
