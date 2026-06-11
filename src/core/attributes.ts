import { AttrValue, BoxJSON } from "./types.js";

export const STRUCTURAL_BOX_KEYS = new Set([
  "id",
  "maxclass",
  "numinlets",
  "numoutlets",
  "outlettype",
  "patching_rect",
  "text",
  "patcher",
  "comment",
]);

export function isReservedAttributeKey(key: string): boolean {
  return STRUCTURAL_BOX_KEYS.has(key);
}

export function applyBoxAttrs(
  box: BoxJSON,
  attrs: Record<string, AttrValue[]> | undefined
): void {
  if (!attrs) return;

  for (const [key, values] of Object.entries(attrs)) {
    (box as Record<string, unknown>)[key] = values.length === 1 ? values[0] : values;
  }
}

export function extractBoxAttrStrings(box: BoxJSON): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(box)) {
    if (STRUCTURAL_BOX_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    result.push(formatAttr(key, value));
  }
  return result;
}

function formatAttr(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.map(v => formatAttrValue(v));
    return `@${key} ${parts.join(" ")}`;
  }
  return `@${key} ${formatAttrValue(value)}`;
}

function formatAttrValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/^[\w.-]+$/.test(value)) return value;
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return String(value);
}
