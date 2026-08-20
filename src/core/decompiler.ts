import { PatcherJSON, BoxJSON, LineJSON } from "./types.js";
import { extractBoxAttrs } from "./attributes.js";

export interface DecompileOptions {
  readonly boxName?: (box: BoxJSON) => string | undefined;
  readonly includeBoxSize?: boolean;
}

export function decompile(
  patch: PatcherJSON,
  subpatcherOutletTypes: readonly string[] = [],
  options: DecompileOptions = {}
): string {
  const lines: string[] = [];
  const p = patch.patcher;
  const signalPortIds = inferSignalPortIds(p, subpatcherOutletTypes);

  if (p.title || p.description || p.rect[2] !== 640 || p.rect[3] !== 480) {
    const sizeStr = `${Math.round(p.rect[2])}x${Math.round(p.rect[3])}`;
    lines.push(
      `patch ${JSON.stringify(p.title ?? "Untitled")} | ` +
      `${JSON.stringify(p.description)} | ${sizeStr}`
    );
    lines.push("");
  }

  const idToName = new Map<string, string>();
  const usedNames = new Set<string>();
  const semanticNames = new Map(
    p.boxes.flatMap(({ box }) => {
      const name = semanticNameFromId(box.id);
      return name ? [[box.id, name] as const] : [];
    })
  );
  const reservedSemanticNames = new Set(semanticNames.values());
  const reservedVarNames = new Set(
    p.boxes.flatMap(({ box }) => {
      const name = varNameFromBox(box);
      return name ? [name] : [];
    })
  );
  const reservedIdentityNames = new Set([
    ...reservedSemanticNames,
    ...reservedVarNames,
  ]);

  for (const bw of p.boxes) {
    const box = bw.box;
    const signalPort = signalPortIds.has(box.id);
    const configuredName = options.boxName?.(box);
    const semanticName = semanticNames.get(box.id);
    const varName = varNameFromBox(box);
    const name = generateName(
      box,
      usedNames,
      signalPort,
      configuredName ?? semanticName ?? varName,
      configuredName !== undefined || semanticName !== undefined,
      varName ? reservedSemanticNames : reservedIdentityNames
    );
    idToName.set(box.id, name);
    usedNames.add(name);

    const dslLine = boxToDSL(box, name, signalPort, options);
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

function generateName(
  box: BoxJSON,
  usedNames: Set<string>,
  signalPort: boolean,
  preferredName?: string,
  requirePreferredName = false,
  reservedNames: ReadonlySet<string> = new Set()
): string {
  if (requirePreferredName && preferredName !== undefined) {
    if (!/^\w+$/.test(preferredName)) {
      throw new Error(
        `Preferred DSL name ${JSON.stringify(preferredName)} is not a valid identifier`
      );
    }
    if (usedNames.has(preferredName)) {
      throw new Error(
        `Preferred DSL name ${JSON.stringify(preferredName)} is duplicated`
      );
    }
    return preferredName;
  }

  const base = sanitizeName(preferredName ?? nameFromBox(box, signalPort));
  let name = base;
  let counter = 2;
  while (usedNames.has(name) || reservedNames.has(name) || name === "") {
    name = `${base}_${counter}`;
    counter++;
  }
  return name;
}

function semanticNameFromId(id: string): string | undefined {
  const name = id.match(/^obj-(\w+)$/)?.[1];
  return name && !/^\d+$/.test(name) ? name : undefined;
}

function varNameFromBox(box: BoxJSON): string | undefined {
  if (
    typeof box.varname === "string" &&
    /^\w+$/.test(box.varname) &&
    !/^maxforge_[A-Za-z_]\w*_obj_\w+$/.test(box.varname)
  ) {
    return box.varname;
  }

  return undefined;
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

function nameFromBox(box: BoxJSON, signalPort: boolean): string {
  if (box.maxclass === "inlet") {
    return signalPort ? "audio_in" : "in";
  }
  if (box.maxclass === "outlet") {
    return signalPort ? "audio_out" : "out";
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

function boxToDSL(
  box: BoxJSON,
  name: string,
  signalPort: boolean,
  options: DecompileOptions
): string {
  const { serialized: attrs, omitted } = extractBoxAttrs(box);
  const attrSuffix = attrs.length > 0 ? " " + attrs.join(" ") : "";
  const posSuffix = positionSuffix(box, options.includeBoxSize ?? false);
  const withOmissionNotice = (line: string) => omitted.length === 0
    ? line
    : `${omitted.map((key) =>
      `# maxforge omitted unsupported attribute @${key} from ${name}`
    ).join("\n")}\n${line}`;

  if (box.maxclass === "comment") {
    const text = box.text || "";
    return withOmissionNotice(
      `${name} = comment "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${attrSuffix}${posSuffix}`
    );
  }

  if (box.maxclass === "message") {
    const text = box.text || "";
    return withOmissionNotice(
      `${name} = message "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${attrSuffix}${posSuffix}`
    );
  }

  if (box.maxclass === "inlet" || box.maxclass === "outlet") {
    const signalSuffix = signalPort ? " signal" : "";
    const comment = (box.comment as string) || "";
    if (comment) {
      return withOmissionNotice(
        `${name} = ${box.maxclass}${signalSuffix} "${comment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${attrSuffix}${posSuffix}`
      );
    }
    return withOmissionNotice(
      `${name} = ${box.maxclass}${signalSuffix}${attrSuffix}${posSuffix}`
    );
  }

  if (box.maxclass === "newobj" && box.text && box.text.startsWith("p ")) {
    const subName = box.text.substring(2);
    if (box.patcher) {
      const inner = decompile(
        { patcher: box.patcher },
        box.outlettype ?? [],
        options
      );
      const innerLines = inner.trim().split("\n");
      const body = innerLines.map((l) => "  " + l).join("\n");
      return withOmissionNotice(
        `${name} = p ${subName}${attrSuffix}${posSuffix} {\n${body}\n}`
      );
    }
    return withOmissionNotice(
      `${name} = p ${subName}${attrSuffix}${posSuffix}`
    );
  }

  if (box.maxclass === "newobj") {
    const objectText = escapeLiteralAttributeTokens(box.text || box.maxclass);
    return withOmissionNotice(`${name} = ${objectText}${attrSuffix}${posSuffix}`);
  }

  return withOmissionNotice(`${name} = ${box.maxclass}${attrSuffix}${posSuffix}`);
}

function inferSignalPortIds(
  patcher: PatcherJSON["patcher"],
  subpatcherOutletTypes: readonly string[]
): Set<string> {
  const signalPortIds = new Set<string>();
  const boxesById = new Map(patcher.boxes.map(({ box }) => [box.id, box]));
  const outlets = patcher.boxes
    .map(({ box }) => box)
    .filter((box) => box.maxclass === "outlet");

  for (const { box } of patcher.boxes) {
    if (box.maxclass === "inlet" && box.outlettype?.[0] === "signal") {
      signalPortIds.add(box.id);
    }
  }

  for (const [index, outlet] of outlets.entries()) {
    if (subpatcherOutletTypes[index] === "signal") {
      signalPortIds.add(outlet.id);
    }
  }

  for (const { patchline } of patcher.lines) {
    const destination = boxesById.get(patchline.destination[0]);
    if (destination?.maxclass !== "outlet") continue;
    const source = boxesById.get(patchline.source[0]);
    if (source?.outlettype?.[patchline.source[1]] === "signal") {
      signalPortIds.add(destination.id);
    }
  }

  return signalPortIds;
}

function escapeLiteralAttributeTokens(text: string): string {
  let result = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"' && !isEscaped(text, i)) {
      inQuotes = !inQuotes;
    }
    if (
      !inQuotes &&
      character === "@" &&
      (i === 0 || /\s/.test(text[i - 1]))
    ) {
      result += "\\";
    }
    result += character;
  }

  return result;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; 0 <= i && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function positionSuffix(box: BoxJSON, includeBoxSize: boolean): string {
  const [x, y, width, height] = box.patching_rect;
  return includeBoxSize
    ? ` at(${x}, ${y}, ${width}, ${height})`
    : ` at(${Math.round(x)}, ${Math.round(y)})`;
}

function lineToDSL(pl: LineJSON, idToName: Map<string, string>): string | null {
  const srcName = idToName.get(pl.source[0]);
  const dstName = idToName.get(pl.destination[0]);

  if (!srcName || !dstName) return null;

  const srcPort = pl.source[1] > 0 ? `[${pl.source[1]}]` : "";
  const dstPort = pl.destination[1] > 0 ? `[${pl.destination[1]}]` : "";

  return `${srcName}${srcPort} -> ${dstName}${dstPort}`;
}
