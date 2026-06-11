import { PatcherJSON, BoxJSON, LineJSON } from "./types.js";

const STANDARD_BOX_KEYS = new Set([
  "id", "maxclass", "numinlets", "numoutlets", "outlettype",
  "patching_rect", "text", "patcher", "comment",
]);

export function decompile(patch: PatcherJSON): string {
  const lines: string[] = [];
  const p = patch.patcher;

  if (p.description || p.rect[2] !== 640 || p.rect[3] !== 480) {
    const sizeStr = `${Math.round(p.rect[2])}x${Math.round(p.rect[3])}`;
    lines.push(`patch "Untitled" | "${p.description}" | ${sizeStr}`);
    lines.push("");
  }

  const idToName = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const bw of p.boxes) {
    const box = bw.box;
    const name = generateName(box, usedNames);
    idToName.set(box.id, name);
    usedNames.add(name);

    const dslLine = boxToDSL(box, name);
    lines.push(dslLine);
  }

  lines.push("");

  for (const lw of p.lines) {
    const pl = lw.patchline;
    const dslLine = lineToDSL(pl, idToName);
    if (dslLine) lines.push(dslLine);
  }

  return lines.join("\n") + "\n";
}

function generateName(box: BoxJSON, usedNames: Set<string>): string {
  const base = nameFromBox(box);
  let name = base;
  let counter = 2;
  while (usedNames.has(name) || name === "") {
    name = `${base}_${counter}`;
    counter++;
  }
  return sanitizeName(name);
}

const OPERATOR_NAMES: Record<string, string> = {
  "*~": "mul",
  "+~": "add",
  "-~": "sub",
  "/~": "div",
  "*": "mul",
  "+": "add",
  "-": "sub",
  "/": "div",
  "==": "eq",
  "!=": "neq",
  ">": "gt",
  "<": "lt",
  ">=": "gte",
  "<=": "lte",
};

const INLET_OUTLET_NAMES: Record<string, string> = {
  inlet: "in",
  "inlet~": "audio_in",
  outlet: "out",
  "outlet~": "audio_out",
};

function nameFromBox(box: BoxJSON): string {
  if (box.maxclass === "inlet" || box.maxclass === "inlet~" ||
      box.maxclass === "outlet" || box.maxclass === "outlet~") {
    return INLET_OUTLET_NAMES[box.maxclass] || box.maxclass;
  }

  if (box.text) {
    const firstToken = box.text.split(/\s+/)[0];

    if (firstToken === "p") {
      const subName = box.text.split(/\s+/)[1] || "sub";
      return sanitizeName(subName);
    }

    if (OPERATOR_NAMES[firstToken]) {
      return OPERATOR_NAMES[firstToken];
    }

    const cleaned = firstToken
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+$/, "")
      .replace(/^_+/, "");

    if (cleaned) return cleaned;
  }

  return sanitizeName(box.maxclass);
}

function sanitizeName(name: string): string {
  let n = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+$/, "").replace(/^_+/, "");
  if (/^\d/.test(n)) n = "_" + n;
  return n || "obj";
}

function boxToDSL(box: BoxJSON, name: string): string {
  const attrs = extractAttrs(box);
  const attrSuffix = attrs.length > 0 ? " " + attrs.join(" ") : "";
  const posSuffix = positionSuffix(box);

  if (box.maxclass === "comment") {
    const text = box.text || "";
    return `${name} = comment "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${attrSuffix}${posSuffix}`;
  }

  if (box.maxclass === "message") {
    const text = box.text || "";
    return `${name} = message "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${attrSuffix}${posSuffix}`;
  }

  if (
    box.maxclass === "inlet" || box.maxclass === "inlet~" ||
    box.maxclass === "outlet" || box.maxclass === "outlet~"
  ) {
    const comment = (box.comment as string) || "";
    if (comment) {
      return `${name} = ${box.maxclass} "${comment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${attrSuffix}${posSuffix}`;
    }
    return `${name} = ${box.maxclass}${attrSuffix}${posSuffix}`;
  }

  if (box.maxclass === "newobj" && box.text && box.text.startsWith("p ")) {
    const subName = box.text.substring(2);
    if (box.patcher) {
      const inner = decompile({ patcher: box.patcher });
      const innerLines = inner.trim().split("\n");
      const body = innerLines.map((l) => "  " + l).join("\n");
      return `${name} = p ${subName}${attrSuffix}${posSuffix} {\n${body}\n}`;
    }
    return `${name} = p ${subName}${attrSuffix}${posSuffix}`;
  }

  if (box.maxclass === "newobj") {
    return `${name} = ${box.text || box.maxclass}${attrSuffix}${posSuffix}`;
  }

  return `${name} = ${box.maxclass}${attrSuffix}${posSuffix}`;
}

function positionSuffix(box: BoxJSON): string {
  const [x, y] = box.patching_rect;
  return ` at(${Math.round(x)}, ${Math.round(y)})`;
}

function extractAttrs(box: BoxJSON): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(box)) {
    if (STANDARD_BOX_KEYS.has(key)) continue;
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

function lineToDSL(pl: LineJSON, idToName: Map<string, string>): string | null {
  const srcName = idToName.get(pl.source[0]);
  const dstName = idToName.get(pl.destination[0]);

  if (!srcName || !dstName) return null;

  const srcPort = pl.source[1] > 0 ? `[${pl.source[1]}]` : "";
  const dstPort = pl.destination[1] > 0 ? `[${pl.destination[1]}]` : "";

  return `${srcName}${srcPort} -> ${dstName}${dstPort}`;
}
