import {
  ArgumentPortCountRule,
  MAX_DECLARATIVE_PORT_COUNT,
  ObjectDef,
  ObjectDatabase,
} from "./types.js";

let db: ObjectDatabase | null = null;

export async function loadDatabase(): Promise<ObjectDatabase> {
  if (db) return db;
  const url = new URL("../../data/objects.json", import.meta.url);
  const fs = await import("fs/promises");
  const raw = await fs.readFile(url.pathname.replace(/^\/C:/, "C:"), "utf-8");
  db = JSON.parse(raw);
  return db!;
}

export function lookupObject(
  objectText: string,
  database: ObjectDatabase,
  allowUnknown = false
): { def: ObjectDef; text: string; maxclass: string } | null {
  const firstToken = extractFirstToken(objectText);

  if (firstToken === "comment") {
    return {
      def: database["comment"] ?? {
        maxclass: "comment",
        numinlets: 1,
        numoutlets: 0,
        outlettype: [],
        defaultSize: [200, 20],
        category: "logic",
      },
      text: extractQuotedContent(objectText),
      maxclass: "comment",
    };
  }

  if (firstToken === "message") {
    return {
      def: database["message"] ?? {
        maxclass: "message",
        numinlets: 2,
        numoutlets: 1,
        outlettype: [""],
        defaultSize: [80, 22],
        category: "logic",
      },
      text: extractQuotedContent(objectText),
      maxclass: "message",
    };
  }

  const entry = database[firstToken];
  if (entry) {
    if (entry.argDependent || entry.argRule || entry.argumentPortRules) {
      const resolved = resolveArgDependent(objectText, entry);
      return { def: resolved, text: objectText, maxclass: entry.maxclass };
    }
    return { def: entry, text: objectText, maxclass: entry.maxclass };
  }

  if (allowUnknown) {
    return {
      def: {
        maxclass: "newobj",
        numinlets: 1,
        numoutlets: 1,
        outlettype: [""],
        defaultSize: [80, 22],
        category: "unknown",
        dynamicPorts: true,
      },
      text: objectText,
      maxclass: "newobj",
    };
  }

  return null;
}

function extractFirstToken(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(\S+)/);
  return match ? match[1] : trimmed;
}

export function extractQuotedContent(text: string): string {
  const afterType = text.replace(/^\S+\s*/, "").trim();
  if (afterType.startsWith('"') && afterType.endsWith('"')) {
    return afterType.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return afterType;
}

function extractArgs(objectText: string): string[] {
  const tokens = tokenizeObjectText(objectText);
  const beforeAttr: string[] = [];
  for (const t of tokens.slice(1)) {
    if (t.startsWith("@")) break;
    beforeAttr.push(t);
  }
  return beforeAttr;
}

function resolveArgDependent(
  objectText: string,
  base: ObjectDef
): ObjectDef {
  const args = extractArgs(objectText);
  const def = { ...base, outlettype: [...base.outlettype] };

  if (base.argumentPortRules) {
    const inletCount = resolvePortCount(args, base.argumentPortRules.inlets);
    const outletCount = resolvePortCount(args, base.argumentPortRules.outlets);
    if (inletCount !== undefined) def.numinlets = inletCount;
    if (outletCount !== undefined) {
      def.numoutlets = outletCount;
      def.outlettype = Array(outletCount).fill(
        base.argumentPortRules.outlets?.outlettype ?? ""
      );
    }
  }

  if (base.argRule === "jit.movie output type from output_texture attribute") {
    def.outlettype = [
      attributeIsNonzero(objectText, "output_texture") ? "jit_gl_texture" : "jit_matrix",
      "",
    ];
    return def;
  }
  if (args.length === 0) return def;

  const firstArg = parseInt(args[0]);
  const argCount = args.length;

  switch (base.argRule) {
    case "outlets = first arg value":
    case "outlets = first arg":
      if (!Number.isFinite(firstArg)) break;
      def.numoutlets = Math.max(1, firstArg);
      def.outlettype = Array(def.numoutlets).fill("");
      break;
    case "signal outlets = first arg":
      if (!Number.isFinite(firstArg)) break;
      def.numoutlets = Math.max(1, firstArg);
      def.outlettype = Array(def.numoutlets).fill("signal");
      break;
    case "inlets = first arg + 1":
      if (!Number.isFinite(firstArg)) break;
      def.numinlets = firstArg + 1;
      break;
    case "outlets = arg count + 1":
      def.numoutlets = argCount + 1;
      def.outlettype = Array(argCount + 1).fill("");
      break;
    case "inlets = arg count":
      def.numinlets = argCount;
      break;
    case "inlets = outlets = first arg":
      if (!Number.isFinite(firstArg)) break;
      def.numinlets = Math.max(1, firstArg);
      def.numoutlets = Math.max(1, firstArg);
      def.outlettype = Array(def.numoutlets).fill("");
      break;
    case "inlets = first arg":
      if (!Number.isFinite(firstArg)) break;
      def.numinlets = firstArg;
      break;
    case "outlets = arg count":
      def.numoutlets = argCount;
      def.outlettype = Array(argCount).fill("");
      break;
    case "inlets = first arg, outlets = second arg":
      def.numinlets = positiveInt(args[0]) ?? base.numinlets;
      def.numoutlets = positiveInt(args[1]) ?? base.numoutlets;
      def.outlettype = Array(def.numoutlets).fill("signal");
      break;
    case "inlets = first arg, outlets = second arg + status": {
      const inlets = positiveInt(args[0]);
      const signalOutlets = positiveInt(args[1]);
      if (inlets === null || signalOutlets === null) break;
      def.numinlets = inlets;
      def.numoutlets = signalOutlets + 1;
      def.outlettype = [...Array(signalOutlets).fill("signal"), ""];
      break;
    }
    case "inlets = arg count, outlets = arg count":
      def.numinlets = argCount;
      def.numoutlets = argCount;
      def.outlettype = Array(argCount).fill("");
      break;
    case "outlets = arg count, outlettype from args": {
      const typeMap: Record<string, string> = {
        b: "bang", bang: "bang",
        i: "int", int: "int",
        f: "float", float: "float",
        l: "", list: "", s: "", symbol: "",
      };
      def.numoutlets = argCount;
      def.outlettype = args.map(a => outletTypeForArgument(a, typeMap));
      break;
    }
    case "inlets = outlets = arg count, default 1 signal": {
      const ports = Math.max(1, argCount);
      def.numinlets = ports;
      def.numoutlets = ports;
      def.outlettype = Array(ports).fill("signal");
      break;
    }
    case "inlets = arg count, default 1":
      def.numinlets = Math.max(1, argCount);
      break;
    case "fixed ports, outlettype from first arg":
      def.outlettype = Array(def.numoutlets).fill(outletTypeForValue(args[0]));
      break;
    case "fixed ports, outlettype from numeric arguments": {
      const type = args.some(argument => outletTypeForValue(argument) === "float")
        ? "float"
        : "int";
      def.outlettype = Array(def.numoutlets).fill(type);
      break;
    }
    case "outlets = arg count, value types from args":
      def.numoutlets = argCount;
      def.outlettype = args.map(outletTypeForValue);
      break;
    case "inlets = outlets = arg count + 1":
      def.numinlets = argCount + 1;
      def.numoutlets = argCount + 1;
      def.outlettype = Array(def.numoutlets).fill("");
      break;
    case "outlets = first arg + status": {
      const outlets = positiveInt(args[0]);
      if (outlets === null) break;
      def.numoutlets = outlets + 1;
      def.outlettype = [...Array(outlets).fill("jit_matrix"), ""];
      break;
    }
    case "inlets = outlets = arg count + 1, matched outlets bang":
      def.numinlets = argCount + 1;
      def.numoutlets = argCount + 1;
      def.outlettype = [...Array(argCount).fill("bang"), ""];
      break;
    case "outlets = arg count, default 2 signals":
      def.numoutlets = argCount;
      def.outlettype = Array(argCount).fill("signal");
      break;
    case "inlets = arg count, default 2":
      def.numinlets = argCount;
      break;
    case "signal outlets = channel arg + completion bang": {
      const firstIsChannel = positiveInt(args[0]);
      const channels = firstIsChannel ?? positiveInt(args[1]) ?? 1;
      const positionFlagIndex = firstIsChannel === null ? 3 : 2;
      const hasPositionOutlet = Number(args[positionFlagIndex]) !== 0 &&
        Number.isFinite(Number(args[positionFlagIndex]));
      def.numoutlets = channels + (hasPositionOutlet ? 1 : 0) + 1;
      def.outlettype = [
        ...Array(channels + (hasPositionOutlet ? 1 : 0)).fill("signal"),
        "bang",
      ];
      break;
    }
    case "signal outlets = second arg + completion bang": {
      const channels = positiveInt(args[1]) ?? 1;
      def.numoutlets = channels + 1;
      def.outlettype = [...Array(channels).fill("signal"), "bang"];
      break;
    }
    case "inlets = second arg + 2": {
      const channels = positiveInt(args[1]) ?? 1;
      def.numinlets = channels + 2;
      break;
    }
    case "signal outlets = second arg + sync outlet": {
      const channels = positiveInt(args[1]) ?? 1;
      def.numoutlets = channels + 1;
      def.outlettype = Array(def.numoutlets).fill("signal");
      break;
    }
    case "inlets = second arg + 1, outlets = second arg": {
      const taps = positiveInt(args[1]);
      if (taps === null) break;
      def.numinlets = taps + 1;
      def.numoutlets = taps;
      def.outlettype = Array(taps).fill("");
      break;
    }
    case "inlets = arg count, outlets = arg count - 1": {
      const values = Math.max(1, argCount - 1);
      def.numinlets = values + 1;
      def.numoutlets = values;
      def.outlettype = Array(values).fill("");
      break;
    }
    case "inlets = format conversion count": {
      const format = args[0]?.toLowerCase() === "symout" ? args.slice(1).join(" ") : args.join(" ");
      const conversions = format.match(/%(?!%)(?:[-+0 #]*\d*(?:\.\d+)?[a-zA-Z])/g)?.length ?? 0;
      def.numinlets = Math.max(1, conversions);
      break;
    }
    case "ports from variable and outN references":
      def.numinlets = maxReferenceIndex(objectText, /\$[ifs](\d+)/gi, 1);
      def.numoutlets = maxReferenceIndex(objectText, /\bout(\d+)\b/gi, 1);
      def.outlettype = Array(def.numoutlets).fill("");
      break;
    case "inlets = max $i/$f/$s reference index":
    case "inlets = max $i/$f reference index":
      def.numinlets = Math.max(
        maxReferenceIndex(objectText, /\$[ifs](\d+)/gi, 1),
        maxReferenceIndex(objectText, /\bin(\d+)\b/gi, 1)
      );
      break;
    case "outlets = first arg, default 2 bangs": {
      const outlets = positiveInt(args[0]) ?? 2;
      def.numoutlets = outlets;
      def.outlettype = Array(outlets).fill("bang");
      break;
    }
    case "one inlet without name, zero with name":
      def.numinlets = args.length === 0 ? 1 : 0;
      break;
  }

  return def;
}

function resolvePortCount(
  args: readonly string[],
  rule: ArgumentPortCountRule | undefined
): number | undefined {
  if (!rule) return undefined;
  let value: number;
  if (rule.source === "argument-count") {
    value = args.length;
  } else {
    const token = rule.index === undefined ? undefined : args[rule.index];
    if (token === undefined || !/^[+-]?\d+$/.test(token)) return undefined;
    value = Number(token);
  }
  value += rule.offset ?? 0;
  value = Math.max(rule.minimum ?? 0, value);
  value = Math.min(rule.maximum ?? MAX_DECLARATIVE_PORT_COUNT, value);
  return value;
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}

function maxReferenceIndex(text: string, pattern: RegExp, fallback: number): number {
  let maximum = fallback;
  for (const match of text.matchAll(pattern)) {
    maximum = Math.max(maximum, Number.parseInt(match[1], 10));
  }
  return maximum;
}

function outletTypeForArgument(
  argument: string,
  typeMap: Record<string, string>
): string {
  const normalized = argument.toLowerCase();
  if (normalized in typeMap) return typeMap[normalized];
  const valueType = outletTypeForValue(argument);
  return valueType || stripQuotes(argument);
}

function outletTypeForValue(argument: string): string {
  const normalized = argument.toLowerCase();
  if (normalized === "i" || normalized === "int") return "int";
  if (normalized === "f" || normalized === "float") return "float";
  if (normalized === "b" || normalized === "bang") return "bang";
  if (/^[+-]?\d+$/.test(argument)) return "int";
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)$/.test(argument)) return "float";
  return "";
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function attributeIsNonzero(text: string, name: string): boolean {
  const tokens = tokenizeObjectText(text);
  const index = tokens.indexOf(`@${name}`);
  if (index < 0 || index + 1 >= tokens.length) return false;
  const value = Number(stripQuotes(tokens[index + 1]));
  return Number.isFinite(value) && value !== 0;
}

function tokenizeObjectText(text: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"' && !isEscaped(text, index)) {
      quoted = !quoted;
      token += character;
      continue;
    }
    if (!quoted && /[ \t\r\n]/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let current = index - 1; current >= 0 && text[current] === "\\"; current--) {
    slashes++;
  }
  return slashes % 2 === 1;
}
