import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createPatchGraph,
  PatchGraph,
  PatchGraphNode,
} from "../max/patch-graph.js";
import type { MaxforgePatcherSnapshot } from "../max/patch-protocol.js";

export interface PendingPatchApply {
  readonly baseRevision: string;
  readonly nextGraph: PatchGraph;
  readonly intentGraph: PatchGraph;
  readonly nextSource: string;
  readonly intentSource: string;
  readonly recoveryBaseGraph?: PatchGraph;
  readonly recoveryBaseSource?: string;
  readonly superseded?: {
    readonly baseRevision: string;
    readonly nextGraph: PatchGraph;
    readonly intentGraph: PatchGraph;
    readonly nextSource: string;
    readonly intentSource: string;
  };
}

export interface PatchServiceState {
  readonly managedGraphs: ReadonlyMap<string, PatchGraph>;
  readonly intentGraphs: ReadonlyMap<string, PatchGraph>;
  readonly workingSources: ReadonlyMap<string, string>;
  readonly intentSources: ReadonlyMap<string, string>;
  readonly baselineSnapshots: ReadonlyMap<string, MaxforgePatcherSnapshot>;
  readonly pendingApplies: ReadonlyMap<string, PendingPatchApply>;
}

export interface PatchStateStore {
  readonly description: string;
  load(): PatchServiceState | undefined;
  save(state: PatchServiceState): void;
}

export interface JsonFilePatchStateStoreOptions {
  readonly legacyPath?: string;
  readonly serializeGraph?: (graph: PatchGraph) => string;
}

interface StateDocument {
  readonly schemaVersion: 2;
  readonly managedGraphs: readonly StateEntry<PatchGraph>[];
  readonly intentGraphs: readonly StateEntry<PatchGraph>[];
  readonly workingSources: readonly StateEntry<string>[];
  readonly intentSources: readonly StateEntry<string>[];
  readonly baselineSnapshots: readonly StateEntry<MaxforgePatcherSnapshot>[];
  readonly pendingApplies: readonly StateEntry<PendingPatchApply>[];
}

interface StateEntry<Value> {
  readonly target: string;
  readonly value: Value;
}

export class JsonFilePatchStateStore implements PatchStateStore {
  readonly description: string;
  private readonly legacyPath?: string;
  private readonly serializeGraph?: (graph: PatchGraph) => string;

  constructor(
    readonly path: string,
    options: JsonFilePatchStateStoreOptions = {}
  ) {
    this.path = resolve(path);
    this.description = this.path;
    this.legacyPath = options.legacyPath
      ? resolve(options.legacyPath)
      : undefined;
    this.serializeGraph = options.serializeGraph;
  }

  load(): PatchServiceState | undefined {
    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return this.loadLegacy();
      throw new Error(`Cannot read maxforge state ${this.path}: ${errorMessage(error)}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new Error(`Invalid maxforge state JSON ${this.path}: ${errorMessage(error)}`);
    }
    return parseStateDocument(raw, this.path);
  }

  private loadLegacy(): PatchServiceState | undefined {
    if (!this.legacyPath) return undefined;
    let source: string;
    try {
      source = readFileSync(this.legacyPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw new Error(
        `Cannot read legacy maxforge state ${this.legacyPath}: ${errorMessage(error)}`
      );
    }
    if (!this.serializeGraph) {
      throw new Error(
        `Cannot migrate legacy maxforge state ${this.legacyPath}: ` +
        "no lossless graph serializer is configured"
      );
    }

    try {
      const raw = JSON.parse(source) as unknown;
      const migrated = parseLegacyStateDocument(
        raw,
        this.legacyPath,
        this.serializeGraph
      );
      this.save(migrated);
      return migrated;
    } catch (error) {
      throw new Error(
        `Cannot migrate legacy maxforge state ${this.legacyPath} to ` +
        `${this.path}: ${errorMessage(error)}. Repair or archive the legacy ` +
        "state before restarting maxforge."
      );
    }
  }

  save(state: PatchServiceState): void {
    const document: StateDocument = {
      schemaVersion: 2,
      managedGraphs: mapEntries(state.managedGraphs),
      intentGraphs: mapEntries(state.intentGraphs),
      workingSources: mapEntries(state.workingSources),
      intentSources: mapEntries(state.intentSources),
      baselineSnapshots: mapEntries(state.baselineSnapshots),
      pendingApplies: mapEntries(state.pendingApplies),
    };
    const directory = dirname(this.path);
    const temporary = `${this.path}.${process.pid}.tmp`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new Error(`Cannot persist maxforge state ${this.path}: ${errorMessage(error)}`);
    }
  }
}

export function stateFileFromEnvironment(
  environment: NodeJS.ProcessEnv,
  port: number,
  projectId?: string
): string | undefined {
  const configured = environment.MAXFORGE_STATE_FILE;
  if (configured === "off") return undefined;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return projectId
    ? join(
      homedir(),
      ".maxforge",
      "projects",
      projectId,
      "mcp-state-v2.json"
    )
    : join(homedir(), ".maxforge", `mcp-state-${port}-v2.json`);
}

export function legacyStateFileFromEnvironment(
  environment: NodeJS.ProcessEnv,
  port: number,
  projectId?: string
): string | undefined {
  const configured = environment.MAXFORGE_STATE_FILE;
  if (configured !== undefined && configured.length > 0) return undefined;
  return projectId
    ? join(
      homedir(),
      ".maxforge",
      "projects",
      projectId,
      "mcp-state-v1.json"
    )
    : join(homedir(), ".maxforge", `mcp-state-${port}-v1.json`);
}

function parseStateDocument(raw: unknown, path: string): PatchServiceState {
  if (!isRecord(raw) || raw.schemaVersion !== 2) {
    throw new Error(`Invalid maxforge state ${path}: expected schemaVersion 2`);
  }
  return {
    managedGraphs: parseGraphEntries(raw.managedGraphs, "managedGraphs", path),
    intentGraphs: parseGraphEntries(raw.intentGraphs, "intentGraphs", path),
    workingSources: parseSourceEntries(raw.workingSources, "workingSources", path),
    intentSources: parseSourceEntries(raw.intentSources, "intentSources", path),
    baselineSnapshots: parseSnapshotEntries(
      raw.baselineSnapshots,
      "baselineSnapshots",
      path
    ),
    pendingApplies: parsePendingEntries(raw.pendingApplies, path),
  };
}

function parseLegacyStateDocument(
  raw: unknown,
  path: string,
  serializeGraph: (graph: PatchGraph) => string
): PatchServiceState {
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error(`Invalid maxforge state ${path}: expected schemaVersion 1`);
  }
  const managedGraphs = parseGraphEntries(raw.managedGraphs, "managedGraphs", path);
  const intentGraphs = parseGraphEntries(raw.intentGraphs, "intentGraphs", path);
  return {
    managedGraphs,
    intentGraphs,
    workingSources: serializeGraphEntries(managedGraphs, serializeGraph),
    intentSources: serializeGraphEntries(intentGraphs, serializeGraph),
    baselineSnapshots: parseSnapshotEntries(
      raw.baselineSnapshots,
      "baselineSnapshots",
      path
    ),
    pendingApplies: parseLegacyPendingEntries(
      raw.pendingApplies,
      path,
      serializeGraph
    ),
  };
}

function parseSourceEntries(
  raw: unknown,
  field: string,
  path: string
): Map<string, string> {
  const entries = parseEntries(raw, field, path);
  return new Map(entries.map(({ target, value }) => {
    if (typeof value !== "string") {
      throw new Error(`Invalid maxforge state ${path}: ${field} source for ${target}`);
    }
    return [target, value];
  }));
}

function serializeGraphEntries(
  graphs: ReadonlyMap<string, PatchGraph>,
  serializeGraph: (graph: PatchGraph) => string
): Map<string, string> {
  return new Map(
    [...graphs].map(([target, graph]) => [target, serializeGraph(graph)])
  );
}

function parseGraphEntries(
  raw: unknown,
  field: string,
  path: string
): Map<string, PatchGraph> {
  const entries = parseEntries(raw, field, path);
  return new Map(entries.map(({ target, value }) => [target, parseGraph(value, field)]));
}

function parsePendingEntries(
  raw: unknown,
  path: string
): Map<string, PendingPatchApply> {
  const entries = parseEntries(raw, "pendingApplies", path);
  return new Map(entries.map(({ target, value }) => {
    if (
      !isRecord(value) ||
      typeof value.baseRevision !== "string" ||
      typeof value.nextSource !== "string" ||
      typeof value.intentSource !== "string"
    ) {
      throw new Error(`Invalid pending apply state for ${target}`);
    }
    const superseded = value.superseded;
    if (
      superseded !== undefined &&
      (!isRecord(superseded) ||
        typeof superseded.baseRevision !== "string" ||
        typeof superseded.nextSource !== "string" ||
        typeof superseded.intentSource !== "string")
    ) {
      throw new Error(`Invalid superseded pending apply state for ${target}`);
    }
    return [target, {
      baseRevision: value.baseRevision,
      nextGraph: parseGraph(value.nextGraph, `pending ${target} nextGraph`),
      intentGraph: parseGraph(value.intentGraph, `pending ${target} intentGraph`),
      nextSource: value.nextSource,
      intentSource: value.intentSource,
      ...(value.recoveryBaseGraph !== undefined
        ? {
            recoveryBaseGraph: parseGraph(
              value.recoveryBaseGraph,
              `pending ${target} recoveryBaseGraph`
            ),
          }
        : {}),
      ...(typeof value.recoveryBaseSource === "string"
        ? { recoveryBaseSource: value.recoveryBaseSource }
        : {}),
      ...(isRecord(superseded) &&
          typeof superseded.baseRevision === "string" &&
          typeof superseded.nextSource === "string" &&
          typeof superseded.intentSource === "string"
        ? {
            superseded: {
              baseRevision: superseded.baseRevision,
              nextGraph: parseGraph(
                superseded.nextGraph,
                `pending ${target} superseded nextGraph`
              ),
              intentGraph: parseGraph(
                superseded.intentGraph,
                `pending ${target} superseded intentGraph`
              ),
              nextSource: superseded.nextSource,
              intentSource: superseded.intentSource,
            },
          }
        : {}),
    }];
  }));
}

function parseLegacyPendingEntries(
  raw: unknown,
  path: string,
  serializeGraph: (graph: PatchGraph) => string
): Map<string, PendingPatchApply> {
  const entries = parseEntries(raw, "pendingApplies", path);
  return new Map(entries.map(({ target, value }) => {
    if (!isRecord(value) || typeof value.baseRevision !== "string") {
      throw new Error(`Invalid pending apply state for ${target}`);
    }
    const nextGraph = parseGraph(value.nextGraph, `pending ${target} nextGraph`);
    const intentGraph = parseGraph(value.intentGraph, `pending ${target} intentGraph`);
    const recoveryBaseGraph = value.recoveryBaseGraph === undefined
      ? undefined
      : parseGraph(value.recoveryBaseGraph, `pending ${target} recoveryBaseGraph`);
    const superseded = value.superseded;
    if (
      superseded !== undefined &&
      (!isRecord(superseded) || typeof superseded.baseRevision !== "string")
    ) {
      throw new Error(`Invalid superseded pending apply state for ${target}`);
    }
    const supersededNextGraph = isRecord(superseded)
      ? parseGraph(superseded.nextGraph, `pending ${target} superseded nextGraph`)
      : undefined;
    const supersededIntentGraph = isRecord(superseded)
      ? parseGraph(superseded.intentGraph, `pending ${target} superseded intentGraph`)
      : undefined;
    return [target, {
      baseRevision: value.baseRevision,
      nextGraph,
      intentGraph,
      nextSource: serializeGraph(nextGraph),
      intentSource: serializeGraph(intentGraph),
      ...(recoveryBaseGraph
        ? {
            recoveryBaseGraph,
            recoveryBaseSource: serializeGraph(recoveryBaseGraph),
          }
        : {}),
      ...(isRecord(superseded) &&
          typeof superseded.baseRevision === "string" &&
          supersededNextGraph &&
          supersededIntentGraph
        ? {
            superseded: {
              baseRevision: superseded.baseRevision,
              nextGraph: supersededNextGraph,
              intentGraph: supersededIntentGraph,
              nextSource: serializeGraph(supersededNextGraph),
              intentSource: serializeGraph(supersededIntentGraph),
            },
          }
        : {}),
    }];
  }));
}

function parseSnapshotEntries(
  raw: unknown,
  field: string,
  path: string
): Map<string, MaxforgePatcherSnapshot> {
  const entries = parseEntries(raw, field, path);
  return new Map(entries.map(({ target, value }) => {
    if (!isPatcherSnapshot(value)) {
      throw new Error(`Invalid ${field} snapshot for ${target}`);
    }
    return [target, value];
  }));
}

function parseEntries(
  raw: unknown,
  field: string,
  path: string
): StateEntry<unknown>[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid maxforge state ${path}: ${field} must be an array`);
  }
  const targets = new Set<string>();
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.target !== "string" || !("value" in entry)) {
      throw new Error(`Invalid maxforge state ${path}: malformed ${field} entry`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*:[A-Za-z_]\w*$/.test(entry.target)) {
      throw new Error(`Invalid maxforge state ${path}: invalid target ${entry.target}`);
    }
    if (targets.has(entry.target)) {
      throw new Error(`Invalid maxforge state ${path}: duplicate target ${entry.target}`);
    }
    targets.add(entry.target);
    return { target: entry.target, value: entry.value };
  });
}

function parseGraph(raw: unknown, label: string): PatchGraph {
  if (
    !isRecord(raw) ||
    raw.protocolVersion !== 1 ||
    typeof raw.scope !== "string" ||
    typeof raw.revision !== "string" ||
    !isRecord(raw.patcher) ||
    !Array.isArray(raw.patcher.boxes) ||
    !Array.isArray(raw.patcher.connections)
  ) {
    throw new Error(`Invalid patch graph in ${label}`);
  }
  const graph = createPatchGraph(raw.scope, raw.patcher as unknown as PatchGraphNode);
  if (graph.revision !== raw.revision) {
    throw new Error(`Patch graph revision mismatch in ${label}`);
  }
  return graph;
}

function isPatcherSnapshot(value: unknown): value is MaxforgePatcherSnapshot {
  return isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.filename === "string" &&
    typeof value.filepath === "string" &&
    typeof value.dirty === "boolean" &&
    typeof value.locked === "boolean" &&
    typeof value.presentation === "boolean" &&
    Array.isArray(value.boxes) &&
    value.boxes.every((box) => isRecord(box) && isRecord(box.attributes)) &&
    Array.isArray(value.connections) &&
    value.connections.every((connection) =>
      isRecord(connection) && isRecord(connection.attributes)
    );
}

function mapEntries<Value>(
  values: ReadonlyMap<string, Value>
): StateEntry<Value>[] {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, value]) => ({ target, value }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
