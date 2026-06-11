import { compile } from "../core/compiler.js";
import { parse } from "../dsl/parser.js";
import {
  BoxJSON,
  CompileError,
  CompileWarning,
  ObjectDatabase,
  PatcherJSON,
} from "../core/types.js";

export type ThispatcherAtom = string | number;

export interface ThispatcherCommand {
  /**
   * Empty means the receiving thispatcher can consume the message directly.
   * Non-empty means the message targets a nested subpatcher path created by
   * earlier commands. A Max-side router/helper must deliver it to that patcher.
   */
  targetPath: string[];
  message: ThispatcherAtom[];
}

export interface ThispatcherOptions {
  /** Prefix for generated Max scripting varnames. */
  varPrefix?: string;
  /** Wrap the compiled root patcher in a parent `p <name>` box. */
  asSubpatcher?: string;
  /** Varname for the wrapper subpatcher box. */
  subpatcherVarName?: string;
  /** Position for the wrapper subpatcher box. */
  subpatcherPosition?: [number, number];
}

export interface ThispatcherCompileResult {
  success: boolean;
  errors: CompileError[];
  warnings: CompileWarning[];
  commands?: ThispatcherCommand[];
}

const BASE_BOX_KEYS = new Set([
  "id",
  "maxclass",
  "numinlets",
  "numoutlets",
  "outlettype",
  "patching_rect",
  "text",
  "comment",
  "patcher",
]);

export function compileDslToThispatcherCommands(
  source: string,
  database: ObjectDatabase,
  allowUnknown = false,
  options: ThispatcherOptions = {}
): ThispatcherCompileResult {
  const { ast, errors: parseErrors } = parse(source);
  if (parseErrors.length > 0) {
    return { success: false, errors: parseErrors, warnings: [] };
  }

  const result = compile(ast, database, allowUnknown, options.asSubpatcher !== undefined);
  if (!result.success) {
    return {
      success: false,
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  return {
    success: true,
    errors: [],
    warnings: result.warnings,
    commands: patcherToThispatcherCommands(result.output!, options),
  };
}

export function patcherToThispatcherCommands(
  patcher: PatcherJSON | PatcherJSON["patcher"],
  options: ThispatcherOptions = {}
): ThispatcherCommand[] {
  const root = "patcher" in patcher ? patcher.patcher : patcher;
  const varPrefix = options.varPrefix ?? "maxforge_";

  if (options.asSubpatcher) {
    const wrapperVar = sanitizeVarName(
      options.subpatcherVarName ?? `${varPrefix}${options.asSubpatcher}`
    );
    const [x, y] = options.subpatcherPosition ?? [100, 100];
    return [
      {
        targetPath: [],
        message: [
          "script",
          "newobject",
          "newobj",
          "@varname",
          wrapperVar,
          "@patching_position",
          x,
          y,
          "@text",
          "p",
          options.asSubpatcher,
        ],
      },
      ...patcherToCommands(root, varPrefix, [wrapperVar]),
    ];
  }

  return patcherToCommands(root, varPrefix, []);
}

export function formatThispatcherCommand(command: ThispatcherCommand): string {
  const prefix =
    command.targetPath.length > 0
      ? `[${command.targetPath.join("/")}] `
      : "";
  return `${prefix}${command.message.map(formatAtom).join(" ")}`;
}

function patcherToCommands(
  patcher: PatcherJSON["patcher"],
  varPrefix: string,
  targetPath: string[]
): ThispatcherCommand[] {
  const idToVarName = new Map<string, string>();
  for (const wrapper of patcher.boxes) {
    const box = wrapper.box;
    idToVarName.set(box.id, sanitizeVarName(`${varPrefix}${box.id}`));
  }

  const commands: ThispatcherCommand[] = [];

  for (const wrapper of patcher.boxes) {
    const box = wrapper.box;
    const varName = idToVarName.get(box.id)!;
    commands.push({ targetPath, message: boxToNewObjectMessage(box, varName) });

    if (box.patcher) {
      commands.push(...patcherToCommands(box.patcher, varPrefix, [...targetPath, varName]));
    }
  }

  for (const wrapper of patcher.lines) {
    const line = wrapper.patchline;
    const source = idToVarName.get(line.source[0]);
    const dest = idToVarName.get(line.destination[0]);
    if (!source || !dest) continue;

    commands.push({
      targetPath,
      message: [
        "script",
        "connect",
        source,
        line.source[1],
        dest,
        line.destination[1],
      ],
    });
  }

  return commands;
}

function boxToNewObjectMessage(box: BoxJSON, varName: string): ThispatcherAtom[] {
  const [x, y, width, height] = box.patching_rect;
  const message: ThispatcherAtom[] = [
    "script",
    "newobject",
    box.maxclass,
    "@varname",
    varName,
    "@patching_position",
    x,
    y,
    "@patching_size",
    width,
    height,
  ];

  appendBoxAttributes(message, box);

  if (box.comment !== undefined) {
    message.push("@comment", ...tokenizeMaxText(box.comment));
  }

  if (box.text !== undefined) {
    message.push("@text", ...tokenizeMaxText(box.text));
  }

  return message;
}

function appendBoxAttributes(message: ThispatcherAtom[], box: BoxJSON): void {
  const entries = Object.entries(box).filter(([key]) => !BASE_BOX_KEYS.has(key));
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    message.push(`@${key}`, ...toAtoms(value));
  }
}

function toAtoms(value: unknown): ThispatcherAtom[] {
  if (typeof value === "number" || typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(toAtoms);
  if (typeof value === "boolean") return [value ? 1 : 0];
  return [JSON.stringify(value)];
}

function tokenizeMaxText(text: string): ThispatcherAtom[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    if (text[i] === '"') {
      let value = "";
      i++;
      while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        value += text[i];
        i++;
      }
      tokens.push(value);
      continue;
    }

    let j = i;
    while (j < text.length && !/\s/.test(text[j])) j++;
    tokens.push(text.substring(i, j));
    i = j;
  }

  return tokens.map((token) => {
    const numberValue = Number(token);
    return token !== "" && Number.isFinite(numberValue) && /^-?\d+(\.\d+)?$/.test(token)
      ? numberValue
      : token;
  });
}

function sanitizeVarName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function formatAtom(atom: ThispatcherAtom): string {
  if (typeof atom === "number") return String(atom);
  return /\s/.test(atom) || atom === "" ? JSON.stringify(atom) : atom;
}
