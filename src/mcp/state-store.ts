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
}

export interface PatchServiceState {
  readonly managedGraphs: ReadonlyMap<string, PatchGraph>;
  readonly intentGraphs: ReadonlyMap<string, PatchGraph>;
  readonly baselineSnapshots: ReadonlyMap<string, MaxforgePatcherSnapshot>;
  readonly pendingApplies: ReadonlyMap<string, PendingPatchApply>;
}

export interface PatchStateStore {
  readonly description: string;
  load(): PatchServiceState | undefined;
  save(state: PatchServiceState): void;
}

interface StateDocument {
  readonly schemaVersion: 1;
  readonly managedGraphs: readonly StateEntry<PatchGraph>[];
  readonly intentGraphs: readonly StateEntry<PatchGraph>[];
  readonly baselineSnapshots: readonly StateEntry<MaxforgePatcherSnapshot>[];
  readonly pendingApplies: readonly StateEntry<PendingPatchApply>[];
}

interface StateEntry<Value> {
  readonly target: string;
  readonly value: Value;
}

export class JsonFilePatchStateStore implements PatchStateStore {
  readonly description: string;

  constructor(readonly path: string) {
    this.path = resolve(path);
    this.description = this.path;
  }

  load(): PatchServiceState | undefined {
    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
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

  save(state: PatchServiceState): void {
    const document: StateDocument = {
      schemaVersion: 1,
      managedGraphs: mapEntries(state.managedGraphs),
      intentGraphs: mapEntries(state.intentGraphs),
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
  port: number
): string | undefined {
  const configured = environment.MAXFORGE_STATE_FILE;
  if (configured === "off") return undefined;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return join(homedir(), ".maxforge", `mcp-state-${port}-v1.json`);
}

function parseStateDocument(raw: unknown, path: string): PatchServiceState {
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error(`Invalid maxforge state ${path}: expected schemaVersion 1`);
  }
  return {
    managedGraphs: parseGraphEntries(raw.managedGraphs, "managedGraphs", path),
    intentGraphs: parseGraphEntries(raw.intentGraphs, "intentGraphs", path),
    baselineSnapshots: parseSnapshotEntries(
      raw.baselineSnapshots,
      "baselineSnapshots",
      path
    ),
    pendingApplies: parsePendingEntries(raw.pendingApplies, path),
  };
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
    if (!isRecord(value) || typeof value.baseRevision !== "string") {
      throw new Error(`Invalid pending apply state for ${target}`);
    }
    return [target, {
      baseRevision: value.baseRevision,
      nextGraph: parseGraph(value.nextGraph, `pending ${target} nextGraph`),
      intentGraph: parseGraph(value.intentGraph, `pending ${target} intentGraph`),
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
