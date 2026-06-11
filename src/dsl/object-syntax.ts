import { AttrValue } from "../core/types.js";

export function parsePositionSuffix(text: string): { text: string; pos?: [number, number] } {
  const posMatch = text.match(/\s+at\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/);
  if (!posMatch) return { text };

  return {
    text: text.substring(0, text.length - posMatch[0].length).trim(),
    pos: [parseInt(posMatch[1]), parseInt(posMatch[2])],
  };
}

export function parseAttributes(text: string): { text: string; attrs: Record<string, AttrValue[]> } {
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
