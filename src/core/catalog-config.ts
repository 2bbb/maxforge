import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import * as z from "zod/v4";
import { loadDatabase } from "./object-db.js";
import {
  BoxJSON,
  MAX_DECLARATIVE_PORT_COUNT,
  ObjectDatabase,
  ObjectDef,
  PatcherJSON,
} from "./types.js";

const CONFIG_FILENAME = "maxforge.config.json";

const fixedPortsSchema = z.object({
  mode: z.literal("fixed"),
  inlets: z.number().int().nonnegative(),
  outlets: z.array(z.string()),
}).strict();

const dynamicPortsSchema = z.object({
  mode: z.literal("dynamic"),
  representative: z.object({
    inlets: z.number().int().nonnegative(),
    outlets: z.array(z.string()),
  }).strict(),
}).strict();

const portCountRuleShape = {
  source: z.enum(["argument", "argument-count"]),
  index: z.number().int().nonnegative().optional(),
  offset: z.number().int().optional(),
  minimum: z.number().int().min(0).max(MAX_DECLARATIVE_PORT_COUNT).optional(),
  maximum: z.number().int().min(0).max(MAX_DECLARATIVE_PORT_COUNT).optional(),
};

function validatePortCountRule(
  rule: z.infer<z.ZodObject<typeof portCountRuleShape>>,
  context: z.RefinementCtx
): void {
  if (rule.source === "argument" && rule.index === undefined) {
    context.addIssue({
      code: "custom",
      path: ["index"],
      message: "index is required when source is argument",
    });
  }
  if (rule.source === "argument-count" && rule.index !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["index"],
      message: "index is not allowed when source is argument-count",
    });
  }
  if (
    rule.minimum !== undefined &&
    rule.maximum !== undefined &&
    rule.maximum < rule.minimum
  ) {
    context.addIssue({
      code: "custom",
      path: ["maximum"],
      message: "maximum must be greater than or equal to minimum",
    });
  }
}

const inletCountRuleSchema = z.object(portCountRuleShape)
  .strict()
  .superRefine(validatePortCountRule);

const outletCountRuleSchema = z.object({
  ...portCountRuleShape,
  outlettype: z.string().optional(),
}).strict().superRefine(validatePortCountRule);

const argumentPortsSchema = z.object({
  mode: z.literal("arguments"),
  representative: z.object({
    inlets: z.number().int().min(0).max(MAX_DECLARATIVE_PORT_COUNT),
    outlets: z.array(z.string()).max(MAX_DECLARATIVE_PORT_COUNT),
  }).strict(),
  inlets: inletCountRuleSchema.optional(),
  outlets: outletCountRuleSchema.optional(),
}).strict().refine((ports) => ports.inlets !== undefined || ports.outlets !== undefined, {
  message: "at least one of inlets or outlets is required",
});

const portsSchema = z.discriminatedUnion("mode", [
  fixedPortsSchema,
  dynamicPortsSchema,
  argumentPortsSchema,
]);

const defaultSizeSchema = z.tuple([
  z.number().positive(),
  z.number().positive(),
]);

const externalSchema = z.object({
  name: z.string().min(1).regex(/^\S+$/, "object name cannot contain whitespace"),
  kind: z.literal("external"),
  path: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1),
  ]).optional(),
  serialization: z.object({
    maxclass: z.string().min(1),
  }).strict().optional(),
  ports: portsSchema,
  defaultSize: defaultSizeSchema.optional(),
  override: z.boolean().optional(),
}).strict();

const abstractionSchema = z.object({
  name: z.string().min(1).regex(/^\S+$/, "object name cannot contain whitespace"),
  path: z.string().min(1),
  ports: z.union([z.literal("derive"), portsSchema]).optional(),
  defaultSize: defaultSizeSchema.optional(),
  override: z.boolean().optional(),
}).strict();

const catalogDocumentSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  catalogs: z.array(z.string().min(1)).optional(),
  objects: z.array(externalSchema).optional(),
  abstractions: z.array(abstractionSchema).optional(),
}).strict();

type PortDeclaration = z.infer<typeof portsSchema>;
type ExternalDeclaration = z.infer<typeof externalSchema>;
type AbstractionDeclaration = z.infer<typeof abstractionSchema>;
type CatalogDocument = z.infer<typeof catalogDocumentSchema>;

export interface CustomObjectInfo {
  readonly name: string;
  readonly kind: "external" | "abstraction";
  readonly source: string;
  readonly path?: string;
  /** All package artifacts for this object; older programmatic catalogs may provide only path. */
  readonly paths?: readonly string[];
  readonly ports: "fixed" | "dynamic" | "arguments";
  readonly definition: ObjectDef;
}

export interface LoadedObjectCatalog {
  readonly database: ObjectDatabase;
  readonly configPath?: string;
  readonly sources: readonly string[];
  readonly digest: string;
  readonly customObjects: readonly CustomObjectInfo[];
}

export interface LoadObjectCatalogOptions {
  readonly configPath?: string;
  readonly inputPath?: string;
  readonly cwd?: string;
  readonly discover?: boolean;
}

export interface CatalogObjectRecord {
  readonly name: string;
  readonly kind: "built-in" | "external" | "abstraction";
  readonly maxclass: string;
  readonly numinlets: number;
  readonly numoutlets: number;
  readonly outlettype: readonly string[];
  readonly dynamicPorts: boolean;
  readonly argumentPorts: boolean;
  readonly source: string;
  readonly path?: string;
  readonly paths?: readonly string[];
}

export function searchObjectCatalog(
  catalog: LoadedObjectCatalog,
  query = "",
  includeBuiltins = false
): readonly CatalogObjectRecord[] {
  const customByName = new Map(
    catalog.customObjects.map((object) => [object.name, object])
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return Object.entries(catalog.database)
    .flatMap(([name, definition]) => {
      const custom = customByName.get(name);
      if (!custom && !includeBuiltins) return [];
      if (
        normalizedQuery &&
        !name.toLocaleLowerCase().includes(normalizedQuery) &&
        !definition.maxclass.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        return [];
      }
      return [{
        name,
        kind: custom?.kind ?? "built-in",
        maxclass: definition.maxclass,
        numinlets: definition.numinlets,
        numoutlets: definition.numoutlets,
        outlettype: [...definition.outlettype],
        dynamicPorts: definition.dynamicPorts === true,
        argumentPorts: definition.argumentPortRules !== undefined,
        source: custom?.source ?? "built-in",
        ...(custom?.path ? { path: custom.path } : {}),
        ...(custom?.paths && custom.paths.length > 1
          ? { paths: [...custom.paths] }
          : {}),
      } satisfies CatalogObjectRecord];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

interface CatalogEntry {
  readonly declaration: ExternalDeclaration | AbstractionDeclaration;
  readonly kind: "external" | "abstraction";
  readonly source: string;
  readonly sourceDirectory: string;
}

export async function loadObjectCatalog(
  options: LoadObjectCatalogOptions = {}
): Promise<LoadedObjectCatalog> {
  const builtIn = await loadDatabase();
  const database = cloneDatabase(builtIn);
  const configPath = options.configPath
    ? resolve(options.cwd ?? process.cwd(), options.configPath)
    : options.discover === false
      ? undefined
      : await findObjectCatalogConfig(options.inputPath, options.cwd);

  if (!configPath) {
    return {
      database,
      sources: [],
      digest: databaseDigest(database),
      customObjects: [],
    };
  }

  const config = await readCatalogDocument(configPath);
  const sources = [configPath];
  const entries: CatalogEntry[] = [];
  const configDirectory = dirname(configPath);

  for (const relativeCatalog of config.catalogs ?? []) {
    const catalogPath = resolve(configDirectory, relativeCatalog);
    const catalog = await readCatalogDocument(catalogPath);
    if (catalog.catalogs !== undefined) {
      throw new Error(
        `Imported catalog cannot import other catalogs: ${catalogPath}`
      );
    }
    sources.push(catalogPath);
    appendEntries(entries, catalog, catalogPath);
  }
  appendEntries(entries, config, configPath);

  const customObjects = new Map<string, CustomObjectInfo>();
  for (const entry of entries) {
    const name = entry.declaration.name;
    if (database[name] && !entry.declaration.override) {
      throw new Error(
        `Object "${name}" is already defined; set override to true in ${entry.source}`
      );
    }

    const info = entry.kind === "external"
      ? await externalInfo(
        entry.declaration as ExternalDeclaration,
        entry.source,
        entry.sourceDirectory
      )
      : await abstractionInfo(
        entry.declaration as AbstractionDeclaration,
        entry.source,
        entry.sourceDirectory
      );
    database[name] = info.definition;
    customObjects.set(name, info);
  }

  return {
    database,
    configPath,
    sources,
    digest: databaseDigest(database),
    customObjects: [...customObjects.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

export async function findObjectCatalogConfig(
  inputPath?: string,
  cwd = process.cwd()
): Promise<string | undefined> {
  let directory = inputPath
    ? dirname(resolve(cwd, inputPath))
    : resolve(cwd);
  const root = parse(directory).root;

  while (true) {
    const candidate = join(directory, CONFIG_FILENAME);
    if (await isFile(candidate)) return candidate;
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

async function readCatalogDocument(path: string): Promise<CatalogDocument> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read object catalog ${path}: ${errorMessage(error)}`);
  }

  const result = catalogDocumentSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "document";
      return `${location}: ${issue.message}`;
    });
    throw new Error(`Invalid object catalog ${path}: ${issues.join("; ")}`);
  }
  return result.data;
}

function appendEntries(
  entries: CatalogEntry[],
  document: CatalogDocument,
  source: string
): void {
  const sourceDirectory = dirname(source);
  for (const declaration of document.objects ?? []) {
    entries.push({ declaration, kind: "external", source, sourceDirectory });
  }
  for (const declaration of document.abstractions ?? []) {
    entries.push({ declaration, kind: "abstraction", source, sourceDirectory });
  }
}

async function externalInfo(
  declaration: ExternalDeclaration,
  source: string,
  sourceDirectory: string
): Promise<CustomObjectInfo> {
  const declaredPaths = declaration.path === undefined
    ? []
    : Array.isArray(declaration.path) ? declaration.path : [declaration.path];
  const externalPaths = [...new Set(
    declaredPaths.map((path) => resolve(sourceDirectory, path))
  )].sort((left, right) => left.localeCompare(right));
  for (const externalPath of externalPaths) {
    if (!await exists(externalPath)) {
      throw new Error(`Could not read external ${externalPath}: path does not exist`);
    }
  }
  const definition = definitionFromPorts(
    declaration.ports,
    declaration.serialization?.maxclass ?? "newobj",
    declaration.defaultSize ?? [80, 22],
    "external"
  );
  return {
    name: declaration.name,
    kind: "external",
    source,
    path: externalPaths[0],
    paths: externalPaths,
    ports: portMode(declaration.ports),
    definition,
  };
}

async function abstractionInfo(
  declaration: AbstractionDeclaration,
  source: string,
  sourceDirectory: string
): Promise<CustomObjectInfo> {
  const abstractionPath = resolve(sourceDirectory, declaration.path);
  if (extname(abstractionPath) !== ".maxpat") {
    throw new Error(`Abstraction path must reference a .maxpat file: ${abstractionPath}`);
  }
  if (basename(abstractionPath, extname(abstractionPath)) !== declaration.name) {
    throw new Error(
      `Abstraction name "${declaration.name}" must match its .maxpat filename: ` +
      abstractionPath
    );
  }
  if (!await isFile(abstractionPath)) {
    throw new Error(`Could not read abstraction ${abstractionPath}: file does not exist`);
  }
  const ports = declaration.ports && declaration.ports !== "derive"
    ? declaration.ports
    : await deriveAbstractionPorts(abstractionPath);
  const definition = definitionFromPorts(
    ports,
    "newobj",
    declaration.defaultSize ?? [100, 22],
    "abstraction"
  );
  return {
    name: declaration.name,
    kind: "abstraction",
    source,
    path: abstractionPath,
    paths: [abstractionPath],
    ports: portMode(ports),
    definition,
  };
}

function definitionFromPorts(
  ports: PortDeclaration,
  maxclass: string,
  defaultSize: [number, number],
  category: string
): ObjectDef {
  const representative = ports.mode === "fixed" ? ports : ports.representative;
  return {
    maxclass,
    numinlets: representative.inlets,
    numoutlets: representative.outlets.length,
    outlettype: [...representative.outlets],
    defaultSize,
    category,
    dynamicPorts: ports.mode === "dynamic" || undefined,
    argumentPortRules: ports.mode === "arguments" ? {
      ...(ports.inlets ? { inlets: { ...ports.inlets } } : {}),
      ...(ports.outlets ? { outlets: { ...ports.outlets } } : {}),
    } : undefined,
  };
}

function portMode(ports: PortDeclaration): CustomObjectInfo["ports"] {
  return ports.mode;
}

async function deriveAbstractionPorts(path: string): Promise<PortDeclaration> {
  let document: PatcherJSON;
  try {
    document = JSON.parse(await readFile(path, "utf8")) as PatcherJSON;
  } catch (error) {
    throw new Error(`Could not read abstraction ${path}: ${errorMessage(error)}`);
  }
  if (!document?.patcher || !Array.isArray(document.patcher.boxes)) {
    throw new Error(`Abstraction must contain a Max patcher: ${path}`);
  }

  const boxes = document.patcher.boxes.map(({ box }) => box);
  const inlets = orderedPorts(boxes.filter((box) => box.maxclass === "inlet"));
  const outlets = orderedPorts(boxes.filter((box) => box.maxclass === "outlet"));
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const outletTypes = outlets.map((outlet) =>
    inferAbstractionOutletType(outlet.id, document.patcher, boxById)
  );

  return {
    mode: "fixed",
    inlets: inlets.length,
    outlets: outletTypes,
  };
}

function orderedPorts(boxes: BoxJSON[]): BoxJSON[] {
  const allIndexed = boxes.every((box) => finiteNumber(box.index) !== undefined);
  return [...boxes].sort((left, right) => {
    if (allIndexed) {
      return finiteNumber(left.index)! - finiteNumber(right.index)!;
    }
    const leftRect = left.patching_rect;
    const rightRect = right.patching_rect;
    return leftRect[0] - rightRect[0] ||
      leftRect[1] - rightRect[1] ||
      left.id.localeCompare(right.id);
  });
}

function inferAbstractionOutletType(
  outletId: string,
  patcher: PatcherJSON["patcher"],
  boxById: ReadonlyMap<string, BoxJSON>
): string {
  for (const { patchline } of patcher.lines) {
    if (patchline.destination[0] !== outletId) continue;
    const source = boxById.get(patchline.source[0]);
    const type = source?.outlettype?.[patchline.source[1]];
    if (type === "signal") return "signal";
  }
  return "";
}

function databaseDigest(database: ObjectDatabase): string {
  const ordered = Object.fromEntries(
    Object.entries(database).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function cloneDatabase(database: ObjectDatabase): ObjectDatabase {
  return Object.fromEntries(Object.entries(database).map(([name, definition]) => [
    name,
    {
      ...definition,
      outlettype: [...definition.outlettype],
      defaultSize: [...definition.defaultSize] as [number, number],
      argumentPortRules: definition.argumentPortRules ? {
        ...(definition.argumentPortRules.inlets
          ? { inlets: { ...definition.argumentPortRules.inlets } }
          : {}),
        ...(definition.argumentPortRules.outlets
          ? { outlets: { ...definition.argumentPortRules.outlets } }
          : {}),
      } : undefined,
    },
  ]));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
