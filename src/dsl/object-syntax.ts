import { AttrValue } from "../core/types.js";

export function parsePositionSuffix(text: string): { text: string; pos?: [number, number] } {
  const posMatch = text.match(/\s+at\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/);
  if (!posMatch) return { text };

  return {
    text: text.substring(0, text.length - posMatch[0].length).trim(),
    pos: [parseInt(posMatch[1]), parseInt(posMatch[2])],
  };
}

export function parseAttributes(text: string): {
  text: string;
  attrs: Record<string, AttrValue[]>;
  errors: string[];
} {
  const attrs: Record<string, AttrValue[]> = {};
  const errors: string[] = [];
  const tokenized = tokenizeWithQuotes(text);
  const tokens = tokenized.tokens;
  errors.push(...tokenized.errors);

  const attrIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith("@")) {
      attrIndices.push(i);
    }
  }

  if (attrIndices.length === 0) {
    return { text: unescapeLiteralAttributeTokens(text), attrs, errors };
  }

  const firstAttr = attrIndices[0];
  const objectTokens = tokens
    .slice(0, firstAttr)
    .map(unescapeLiteralAttributeToken);

  for (const startIdx of attrIndices) {
    const key = tokens[startIdx].substring(1);
    const endIdx = attrIndices.find(idx => idx > startIdx) ?? tokens.length;
    if (!/^\w+$/.test(key)) {
      errors.push(`Invalid attribute name: ${tokens[startIdx]}`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      errors.push(`Duplicate attribute: @${key}`);
      continue;
    }
    const values: AttrValue[] = [];
    for (let j = startIdx + 1; j < endIdx; j++) {
      const token = unescapeLiteralAttributeToken(tokens[j]);
      if (/^-?\d+(\.\d+)?$/.test(token)) {
        values.push(parseFloat(token));
      } else {
        values.push(stripQuotes(token));
      }
    }
    if (values.length === 0) {
      errors.push(`Attribute @${key} requires at least one value`);
      continue;
    }
    attrs[key] = values;
  }

  return { text: objectTokens.join(" "), attrs, errors };
}

function unescapeLiteralAttributeTokens(text: string): string {
  let result = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"' && !isEscaped(text, i)) {
      inQuotes = !inQuotes;
    }
    if (
      !inQuotes &&
      character === "\\" &&
      text[i + 1] === "@" &&
      (i === 0 || /\s/.test(text[i - 1]))
    ) {
      result += "@";
      i++;
      continue;
    }
    result += character;
  }

  return result;
}

function unescapeLiteralAttributeToken(token: string): string {
  return token.startsWith("\\@") ? token.substring(1) : token;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; 0 <= i && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function tokenizeWithQuotes(text: string): { tokens: string[]; errors: string[] } {
  const tokens: string[] = [];
  const errors: string[] = [];
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
      if (j >= text.length) {
        errors.push("Unterminated quoted string");
        tokens.push(text.substring(i));
        break;
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
  return { tokens, errors };
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeQuotedValue(s.substring(1, s.length - 1));
  }
  return s;
}

function unescapeQuotedValue(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && (value[i + 1] === "\\" || value[i + 1] === '"')) {
      result += value[i + 1];
      i++;
    } else {
      result += value[i];
    }
  }
  return result;
}
