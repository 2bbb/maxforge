import { ObjectDef, ObjectDatabase } from "./types.js";

let db: ObjectDatabase | null = null;

export async function loadDatabase(): Promise<ObjectDatabase> {
  if (db) return db;
  const url = new URL("../../data/objects.json", import.meta.url);
  const fs = await import("fs/promises");
  const raw = await fs.readFile(url.pathname.replace(/^\/C:/, "C:"), "utf-8");
  db = JSON.parse(raw);
  return db!;
}

export function setDatabase(override: ObjectDatabase): void {
  db = override;
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
    if (entry.argDependent) {
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

function extractQuotedContent(text: string): string {
  const afterType = text.replace(/^\S+\s*/, "").trim();
  if (afterType.startsWith('"') && afterType.endsWith('"')) {
    return afterType.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return afterType;
}

function extractArgs(objectText: string): string[] {
  const tokens = objectText.trim().split(/\s+/);
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

  if (args.length === 0) return def;

  const firstArg = parseInt(args[0]);
  const argCount = args.length;

  switch (base.argRule) {
    case "outlets = first arg value":
    case "outlets = first arg":
      def.numoutlets = firstArg;
      def.outlettype = Array(firstArg).fill("");
      break;
    case "inlets = first arg + 1":
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
      def.numinlets = firstArg;
      def.numoutlets = firstArg;
      def.outlettype = Array(firstArg).fill("");
      break;
    case "inlets = first arg":
      def.numinlets = firstArg;
      break;
    case "outlets = arg count":
      def.numoutlets = argCount;
      def.outlettype = Array(argCount).fill("");
      break;
    case "inlets = first arg, outlets = second arg":
      def.numinlets = args.length >= 1 ? parseInt(args[0]) : base.numinlets;
      def.numoutlets = args.length >= 2 ? parseInt(args[1]) : base.numoutlets;
      def.outlettype = Array(def.numoutlets).fill("signal");
      break;
    case "inlets = outlets = first arg * 2":
      def.numinlets = firstArg;
      def.numoutlets = firstArg;
      def.outlettype = Array(firstArg).fill("signal");
      break;
  }

  return def;
}
