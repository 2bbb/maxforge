import { ObjectDefStmt, Statement } from "./types.js";

export const INLET_OBJECT_TYPES = ["inlet"] as const;
export const OUTLET_OBJECT_TYPES = ["outlet"] as const;

const PORT_OBJECT_TYPES = [
  ...INLET_OBJECT_TYPES,
  ...OUTLET_OBJECT_TYPES,
] as const;

export interface PortObjectSpec {
  kind: "inlet" | "outlet";
  signal: boolean;
  comment?: string;
}

export function firstObjectToken(objectText: string): string {
  return objectText.trim().split(/\s+/)[0] ?? "";
}

export function isPortObjectToken(objectType: string): boolean {
  return PORT_OBJECT_TYPES.includes(objectType as typeof PORT_OBJECT_TYPES[number]);
}

export function isPortObjectStmt(
  stmt: Statement,
  objectTypes: readonly string[]
): stmt is ObjectDefStmt {
  return stmt.type === "object_def" && objectTypes.some((type) =>
    isObjectTextKind(stmt.objectText, type)
  );
}

export function isObjectTextKind(objectText: string, objectType: string): boolean {
  const trimmed = objectText.trim();
  return trimmed === objectType || trimmed.startsWith(`${objectType} `);
}

export function parsePortObject(objectText: string): PortObjectSpec | null {
  const trimmed = objectText.trim();
  const kind = firstObjectToken(trimmed);
  if (kind !== "inlet" && kind !== "outlet") return null;

  let remainder = trimmed.slice(kind.length).trim();
  let signal = false;
  if (remainder === "signal" || remainder.startsWith("signal ")) {
    signal = true;
    remainder = remainder.slice("signal".length).trim();
  }

  const comment = parseComment(remainder);
  return { kind, signal, comment };
}

function parseComment(text: string): string | undefined {
  if (text === "") return undefined;
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return text;
}
