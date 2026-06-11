import { ObjectDefStmt, Statement } from "./types.js";

export const INLET_OBJECT_TYPES = ["inlet", "inlet~"] as const;
export const OUTLET_OBJECT_TYPES = ["outlet", "outlet~"] as const;

const PORT_OBJECT_TYPES = [
  ...INLET_OBJECT_TYPES,
  ...OUTLET_OBJECT_TYPES,
] as const;

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
