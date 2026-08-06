export interface SourceLine {
  text: string;
  line: number;
}

export interface CollectedBlock {
  lines: SourceLine[];
  nextIndex: number;
  closed: boolean;
  closeLine?: number;
}

export function toSourceLines(source: string): SourceLine[] {
  return source.split("\n").map((text, index) => ({ text, line: index + 1 }));
}

export function collectBlock(sourceLines: SourceLine[], startIndex: number): CollectedBlock {
  const lines: SourceLine[] = [];
  let depth = 1;
  let i = startIndex;

  while (i < sourceLines.length) {
    const current = sourceLines[i];
    const trimmed = current.text.trim();

    if (/^}\s*else\s*{$/.test(trimmed)) {
      if (depth === 1) {
        return { lines, nextIndex: i, closed: true, closeLine: current.line };
      }
      lines.push(current);
    } else if (trimmed.endsWith("{")) {
      depth++;
      lines.push(current);
    } else if (trimmed === "}") {
      depth--;
      if (depth === 0) {
        return { lines, nextIndex: i + 1, closed: true, closeLine: current.line };
      }
      lines.push(current);
    } else {
      lines.push(current);
    }
    i++;
  }

  return { lines, nextIndex: i, closed: false };
}
