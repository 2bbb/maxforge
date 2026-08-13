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

export function extractBoxAttrs(box: BoxJSON): {
  serialized: string[];
  omitted: string[];
} {
  const serialized: string[] = [];
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(box)) {
    if (STRUCTURAL_BOX_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    const formatted = formatAttr(key, value);
    if (formatted === null) omitted.push(key);
    else serialized.push(formatted);
  }
  return { serialized, omitted };
}

function formatAttr(key: string, value: unknown): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0 || value.some((part) => !isAttrValue(part))) return null;
    const parts = value.map(v => formatAttrValue(v));
    return `@${key} ${parts.join(" ")}`;
  }
  if (!isAttrValue(value)) return null;
  return `@${key} ${formatAttrValue(value)}`;
}

function isAttrValue(value: unknown): value is AttrValue {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

function formatAttrValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Attribute parsing distinguishes numeric atoms from symbol atoms. Keep
    // numeric-looking symbols quoted when Max normalizes abstraction args.
    if (/^[\w.-]+$/.test(value) && !/^-?\d+(?:\.\d+)?$/.test(value)) {
      return value;
    }
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return String(value);
}
