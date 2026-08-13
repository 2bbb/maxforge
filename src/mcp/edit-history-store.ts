import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectIdentity } from "../core/catalog-config.js";
import type {
  MaxforgeEditObservedEvent,
  MaxforgeObservationBaseline,
  MaxforgePatchHistoryIdentity,
  MaxforgePatchHistoryIdentityStatus,
  MaxforgePatchInfo,
  MaxforgeRetainedEditObservation,
  ResolveMaxforgePatchHistoryIdentityRequest,
  ResolveMaxforgePatchHistoryIdentityResult,
} from "../max/patch-protocol.js";
import { PatchHistoryIdentityLedger } from "./patch-history-identity.js";

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STRUCTURE_TOKEN_PATTERN = /^[a-f0-9]{16}$/;
const WRITER_LEASE_FILENAME = "writer-v1.lock";

export interface EditHistoryStoreOptions {
  readonly directory: string;
  readonly project: ProjectIdentity;
  readonly maxBytes?: number;
  readonly maxAgeDays?: number;
  readonly chunkBytes?: number;
}

export interface LoadedEditHistory {
  readonly observations: readonly MaxforgeRetainedEditObservation[];
  readonly nextSequence: number;
}

export interface PersistedPatchMetadata {
  readonly projectId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly observedAt: string;
  readonly reason: "registered" | "saved";
  readonly title: string;
  readonly filename: string;
  readonly filepath: string;
}

export interface EditHistoryStoreStatus {
  readonly enabled: true;
  readonly projectId: string;
  readonly location: string;
  readonly warnings: readonly string[];
}

export interface ErasedEditHistory {
  readonly projectId: string;
  readonly location: string;
  readonly filesDeleted: number;
  readonly bytesDeleted: number;
  readonly directoryRemoved: boolean;
}

interface SessionState {
  readonly patch: MaxforgePatchInfo;
  readonly baseline: MaxforgeObservationBaseline;
  readonly startedAt: string;
  chunk: number;
  path: string;
  bytes: number;
}

interface SessionHeaderRecord {
  readonly schemaVersion: 1;
  readonly record: "session";
  readonly project: ProjectIdentity;
  readonly patch: MaxforgePatchInfo;
  readonly startedAt: string;
  readonly baseline: MaxforgeObservationBaseline;
}

interface ObservationRecord {
  readonly schemaVersion: 1;
  readonly record: "observation";
  readonly sequence: number;
  readonly sessionSequence: number;
  readonly observedAt: string;
  readonly event: MaxforgeEditObservedEvent;
}

interface MetadataRecord {
  readonly schemaVersion: 1;
  readonly record: "metadata";
  readonly observedAt: string;
  readonly reason: "saved";
  readonly patch: MaxforgePatchInfo;
}

interface WriterLease {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

export interface EditHistoryStore {
  readonly description: string;
  acquireWriterLease(): void;
  releaseWriterLease(): void;
  load(): LoadedEditHistory;
  startSession(
    patch: MaxforgePatchInfo,
    baseline: MaxforgeObservationBaseline,
    startedAt: string
  ): void;
  appendObservation(observation: MaxforgeRetainedEditObservation): void;
  recordPatchMetadata(
    patch: MaxforgePatchInfo,
    observedAt: string,
    reason: "saved"
  ): void;
  patchMetadata(patcherId: string, scope: string): readonly PersistedPatchMetadata[];
  patchIdentity(
    patcherId: string,
    scope: string
  ): MaxforgePatchHistoryIdentityStatus;
  matchesPatchIdentity(
    historicalPatcherId: string,
    historicalScope: string,
    requestedPatcherId: string,
    requestedScope: string
  ): boolean;
  resolvePatchIdentity(
    request: ResolveMaxforgePatchHistoryIdentityRequest
  ): ResolveMaxforgePatchHistoryIdentityResult;
  eraseProjectHistory(
    expectedProjectId: string,
    confirmation: string
  ): ErasedEditHistory;
  status(): EditHistoryStoreStatus;
}

export class JsonLinesEditHistoryStore implements EditHistoryStore {
  readonly description: string;
  readonly directory: string;
  private readonly project: ProjectIdentity;
  private readonly maxBytes: number;
  private readonly maxAgeMilliseconds: number;
  private readonly chunkBytes: number;
  private readonly identityLedger: PatchHistoryIdentityLedger;
  private readonly sessions = new Map<string, SessionState>();
  private readonly metadata = new Map<string, PersistedPatchMetadata[]>();
  private readonly warnings: string[] = [];
  private writerLeaseToken: string | undefined;

  constructor(options: EditHistoryStoreOptions) {
    this.directory = resolve(options.directory);
    this.description = this.directory;
    this.project = { ...options.project };
    this.identityLedger = new PatchHistoryIdentityLedger(
      this.directory,
      this.project.id
    );
    this.maxBytes = positiveInteger(
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      "edit history maxBytes"
    );
    const maxAgeDays = positiveNumber(
      options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
      "edit history maxAgeDays"
    );
    this.maxAgeMilliseconds = maxAgeDays * 24 * 60 * 60 * 1000;
    this.chunkBytes = positiveInteger(
      options.chunkBytes ?? Math.min(DEFAULT_CHUNK_BYTES, this.maxBytes),
      "edit history chunkBytes"
    );
    if (this.maxBytes < this.chunkBytes) {
      throw new Error("edit history chunkBytes cannot exceed maxBytes");
    }
  }

  acquireWriterLease(): void {
    if (this.writerLeaseToken) {
      throw new Error(`Edit-history writer lease is already held by this store`);
    }
    this.ensureDirectory();
    const token = randomUUID();
    const source = `${JSON.stringify({
      schemaVersion: 1,
      projectId: this.project.id,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    })}\n`;
    const path = this.writerLeasePath();
    let created = false;
    try {
      const descriptor = openSync(path, "wx", 0o600);
      created = true;
      try {
        writeFileSync(descriptor, source, "utf8");
      } finally {
        closeSync(descriptor);
      }
      this.writerLeaseToken = token;
    } catch (error) {
      if (created) rmSync(path, { force: true });
      if (!isAlreadyExistsError(error)) throw error;
      throw new Error(
        `Edit history ${this.directory} already has an active writer lease. ` +
        "Use one maxforge-mcp process per project; if the prior process crashed, " +
        `verify it is stopped before removing ${path}.`
      );
    }
  }

  releaseWriterLease(): void {
    const token = this.writerLeaseToken;
    if (!token) return;
    this.writerLeaseToken = undefined;
    const path = this.writerLeasePath();
    try {
      const lease = parseWriterLease(readFileSync(path, "utf8"));
      if (lease?.token === token) rmSync(path, { force: true });
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    removeEmptyDirectory(this.directory);
  }

  load(): LoadedEditHistory {
    this.ensureDirectory();
    this.warnings.length = 0;
    this.sessions.clear();
    this.prune(new Set());
    this.metadata.clear();
    this.warnings.push(...this.identityLedger.load());
    const observations: MaxforgeRetainedEditObservation[] = [];
    for (const path of this.historyFiles()) {
      this.readHistoryFile(path, observations);
    }
    observations.sort((left, right) =>
      left.sequence - right.sequence ||
      left.sessionId.localeCompare(right.sessionId) ||
      left.sessionSequence - right.sessionSequence
    );
    const deduplicated = deduplicateObservations(observations, this.warnings);
    return {
      observations: deduplicated,
      nextSequence: (deduplicated.at(-1)?.sequence ?? 0) + 1,
    };
  }

  startSession(
    patch: MaxforgePatchInfo,
    baseline: MaxforgeObservationBaseline,
    startedAt: string
  ): void {
    validatePatchInfo(patch);
    validateBaseline(baseline);
    validateTimestamp(startedAt, "session start");
    this.ensureDirectory();
    const state: SessionState = {
      patch: { ...patch },
      baseline,
      startedAt,
      chunk: 1,
      path: "",
      bytes: 0,
    };
    this.openChunk(state);
    this.sessions.set(patch.sessionId, state);
    this.identityLedger.observe({
      patcherId: patch.patcherId,
      scope: patch.scope,
    });
    this.addMetadata(metadataFromPatch(
      this.project.id,
      patch,
      startedAt,
      "registered"
    ));
    this.prune(new Set([state.path]));
  }

  appendObservation(observation: MaxforgeRetainedEditObservation): void {
    const state = this.sessions.get(observation.sessionId);
    if (!state) {
      throw new Error(
        `Cannot persist observation for unknown session ${observation.sessionId}`
      );
    }
    if (
      observation.instanceId !== state.patch.instanceId ||
      observation.event.patcherId !== state.patch.patcherId ||
      observation.event.scope !== state.patch.scope
    ) {
      throw new Error("Cannot persist observation with mismatched patch identity");
    }
    const record: ObservationRecord = {
      schemaVersion: 1,
      record: "observation",
      sequence: observation.sequence,
      sessionSequence: observation.sessionSequence,
      observedAt: observation.observedAt,
      event: observation.event,
    };
    const line = jsonLine(record);
    if (this.chunkBytes < state.bytes + Buffer.byteLength(line)) {
      state.chunk++;
      this.openChunk(state);
    }
    appendFileSync(state.path, line, { encoding: "utf8", mode: 0o600 });
    state.bytes += Buffer.byteLength(line);
    this.prune(new Set([state.path]));
  }

  recordPatchMetadata(
    patch: MaxforgePatchInfo,
    observedAt: string,
    reason: "saved"
  ): void {
    validatePatchInfo(patch);
    validateTimestamp(observedAt, "patch metadata");
    const state = this.sessions.get(patch.sessionId);
    if (!state) {
      throw new Error(`Cannot persist metadata for unknown session ${patch.sessionId}`);
    }
    const record: MetadataRecord = {
      schemaVersion: 1,
      record: "metadata",
      observedAt,
      reason,
      patch,
    };
    const line = jsonLine(record);
    if (this.chunkBytes < state.bytes + Buffer.byteLength(line)) {
      state.chunk++;
      this.openChunk(state);
    }
    appendFileSync(state.path, line, { encoding: "utf8", mode: 0o600 });
    state.bytes += Buffer.byteLength(line);
    this.addMetadata(metadataFromPatch(
      this.project.id,
      patch,
      observedAt,
      reason
    ));
    this.prune(new Set([state.path]));
  }

  patchMetadata(
    patcherId: string,
    scope: string
  ): readonly PersistedPatchMetadata[] {
    const requested = { patcherId, scope };
    if (this.identityLedger.isForgotten(requested)) return [];
    return [...this.metadata.entries()]
      .filter(([key]) => this.identityLedger.matches(identityFromKey(key), requested))
      .flatMap(([, entries]) => entries)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  }

  patchIdentity(
    patcherId: string,
    scope: string
  ): MaxforgePatchHistoryIdentityStatus {
    return this.identityLedger.status(patcherId, scope);
  }

  matchesPatchIdentity(
    historicalPatcherId: string,
    historicalScope: string,
    requestedPatcherId: string,
    requestedScope: string
  ): boolean {
    return this.identityLedger.matches(
      { patcherId: historicalPatcherId, scope: historicalScope },
      { patcherId: requestedPatcherId, scope: requestedScope }
    );
  }

  resolvePatchIdentity(
    request: ResolveMaxforgePatchHistoryIdentityRequest
  ): ResolveMaxforgePatchHistoryIdentityResult {
    return this.identityLedger.resolve(request);
  }

  eraseProjectHistory(
    expectedProjectId: string,
    confirmation: string
  ): ErasedEditHistory {
    if (expectedProjectId !== this.project.id) {
      throw new Error(
        `Expected project id ${expectedProjectId}, but edit history belongs to ${this.project.id}`
      );
    }
    const expectedConfirmation = `ERASE PROJECT HISTORY ${this.project.id}`;
    if (confirmation !== expectedConfirmation) {
      throw new Error(
        `Project history erasure requires exact confirmation: ${expectedConfirmation}`
      );
    }

    const files = this.ownedHistoryFiles();
    const bytesDeleted = files.reduce(
      (total, path) => total + statSync(path).size,
      0
    );
    const directories = [...new Set(files.map(dirname))]
      .filter((path) => path !== this.directory)
      .sort((left, right) => right.length - left.length);
    for (const path of files) rmSync(path, { force: true });
    for (const path of directories) removeEmptyDirectory(path);
    const directoryRemoved = removeEmptyDirectory(this.directory);

    this.sessions.clear();
    this.metadata.clear();
    this.warnings.length = 0;
    this.identityLedger.load();
    return {
      projectId: this.project.id,
      location: this.directory,
      filesDeleted: files.length,
      bytesDeleted,
      directoryRemoved,
    };
  }

  status(): EditHistoryStoreStatus {
    return {
      enabled: true,
      projectId: this.project.id,
      location: this.directory,
      warnings: [...new Set([...this.warnings, ...this.metadataWarnings()])],
    };
  }

  private openChunk(state: SessionState): void {
    const targetDirectory = join(
      this.directory,
      `${state.patch.patcherId}--${state.patch.scope}`
    );
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    chmodSync(targetDirectory, 0o700);
    const timestamp = Date.parse(state.startedAt);
    state.path = join(
      targetDirectory,
      `${timestamp}-${state.patch.sessionId}-${String(state.chunk).padStart(6, "0")}.ndjson`
    );
    const header: SessionHeaderRecord = {
      schemaVersion: 1,
      record: "session",
      project: this.project,
      patch: state.patch,
      startedAt: state.startedAt,
      baseline: state.baseline,
    };
    const source = jsonLine(header);
    writeFileSync(state.path, source, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    state.bytes = Buffer.byteLength(source);
  }

  private writerLeasePath(): string {
    return join(this.directory, WRITER_LEASE_FILENAME);
  }

  private readHistoryFile(
    path: string,
    observations: MaxforgeRetainedEditObservation[]
  ): void {
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n");
    if (lines.at(-1) === "") lines.pop();
    let header: SessionHeaderRecord;
    try {
      header = parseSessionHeader(JSON.parse(lines[0] ?? ""), path);
    } catch (error) {
      this.warn(`${path}: ${errorMessage(error)}`);
      return;
    }
    if (header.project.id !== this.project.id) {
      this.warn(
        `${path}: ignored history for project ${header.project.id}; expected ${this.project.id}`
      );
      return;
    }
    this.identityLedger.observe({
      patcherId: header.patch.patcherId,
      scope: header.patch.scope,
    });
    this.addMetadata(metadataFromPatch(
      this.project.id,
      header.patch,
      header.startedAt,
      "registered"
    ));
    for (let index = 1; index < lines.length; index++) {
      let raw: unknown;
      try {
        raw = JSON.parse(lines[index]);
      } catch (error) {
        if (index === lines.length - 1) {
          this.warn(`${path}: ignored incomplete final record`);
          return;
        }
        this.warn(`${path}: invalid record ${index + 1}: ${errorMessage(error)}`);
        return;
      }
      if (isMetadataRecord(raw, header)) {
        this.addMetadata(metadataFromPatch(
          this.project.id,
          raw.patch,
          raw.observedAt,
          raw.reason
        ));
        continue;
      }
      const observation = parseObservationRecord(raw, header, path, index + 1);
      if (!observation) {
        this.warn(`${path}: ignored invalid record ${index + 1}`);
        continue;
      }
      observations.push(observation);
    }
  }

  private prune(excluded: ReadonlySet<string>): void {
    const now = Date.now();
    let files = this.historyFiles().map((path) => ({ path, stat: statSync(path) }));
    for (const file of files) {
      if (
        !excluded.has(file.path) &&
        this.maxAgeMilliseconds < now - file.stat.mtimeMs
      ) {
        rmSync(file.path, { force: true });
      }
    }
    files = this.historyFiles()
      .map((path) => ({ path, stat: statSync(path) }))
      .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
    let total = files.reduce((sum, file) => sum + file.stat.size, 0);
    for (const file of files) {
      if (total <= this.maxBytes) break;
      if (excluded.has(file.path)) continue;
      rmSync(file.path, { force: true });
      total -= file.stat.size;
    }
    if (this.maxBytes < total) {
      this.warn(
        `active edit-history chunk exceeds the ${this.maxBytes}-byte retention limit`
      );
    }
  }

  private historyFiles(): string[] {
    try {
      return readdirSync(this.directory, { recursive: true, withFileTypes: true })
        .filter((entry) =>
          entry.isFile() &&
          entry.name.endsWith(".ndjson") &&
          entry.name !== "identity-resolutions-v1.ndjson"
        )
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private ownedHistoryFiles(): string[] {
    try {
      return readdirSync(this.directory, { recursive: true, withFileTypes: true })
        .filter((entry) => {
          if (!entry.isFile()) return false;
          if (
            entry.parentPath === this.directory &&
            entry.name === "identity-resolutions-v1.ndjson"
          ) return true;
          return dirname(entry.parentPath) === this.directory &&
            /^[A-Za-z_][A-Za-z0-9_-]*--[A-Za-z_][A-Za-z0-9_-]*$/.test(
              basename(entry.parentPath)
            ) &&
            /^\d+-[A-Za-z0-9_-]{1,128}-\d{6}\.ndjson$/.test(entry.name);
        })
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private addMetadata(metadata: PersistedPatchMetadata): void {
    const key = targetKey(metadata.patcherId, metadata.scope);
    this.identityLedger.observe({
      patcherId: metadata.patcherId,
      scope: metadata.scope,
    });
    const entries = this.metadata.get(key) ?? [];
    const duplicate = entries.some((entry) =>
      entry.sessionId === metadata.sessionId &&
      entry.observedAt === metadata.observedAt &&
      entry.reason === metadata.reason
    );
    if (!duplicate) {
      entries.push(metadata);
      entries.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
      this.metadata.set(key, entries);
    }
  }

  private metadataWarnings(): string[] {
    const result: string[] = [];
    const pathIdentities = new Map<string, Set<string>>();
    for (const [key, entries] of this.metadata) {
      const identity = identityFromKey(key);
      if (this.identityLedger.isForgotten(identity)) continue;
      const canonicalIdentity = this.identityLedger.canonical(identity);
      const canonical = targetKey(
        canonicalIdentity.patcherId,
        canonicalIdentity.scope
      );
      for (const entry of entries) {
        if (entry.filepath.length === 0) continue;
        const identities = pathIdentities.get(entry.filepath) ?? new Set<string>();
        identities.add(canonical);
        pathIdentities.set(entry.filepath, identities);
      }
      const saved = entries.filter((entry) => entry.filepath.length > 0);
      if (saved.some((entry) => saved.some((other) =>
        entry.instanceId !== other.instanceId && entry.filepath !== other.filepath
      ))) {
        result.push(
          `patch ${identity.patcherId}:${identity.scope} changed saved path across native instances; verify move, Save As, or duplicate identity`
        );
      }
    }
    for (const [filepath, identities] of pathIdentities) {
      if (1 < identities.size) {
        result.push(
          `saved path ${filepath} is associated with multiple patch identities`
        );
      }
    }
    return result;
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
}

export function editHistoryDirectoryFromEnvironment(
  environment: NodeJS.ProcessEnv,
  project: ProjectIdentity | undefined
): string | undefined {
  if (environment.MAXFORGE_EDIT_HISTORY === "off" || !project) return undefined;
  const configured = environment.MAXFORGE_EDIT_HISTORY_DIR;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return join(
    homedir(),
    ".maxforge",
    "projects",
    project.id,
    "edit-history-v1"
  );
}

export function editHistoryOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  project: ProjectIdentity,
  directory: string
): EditHistoryStoreOptions {
  return {
    directory,
    project,
    maxBytes: integerEnvironment(
      environment,
      "MAXFORGE_EDIT_HISTORY_MAX_BYTES",
      DEFAULT_MAX_BYTES
    ),
    maxAgeDays: numberEnvironment(
      environment,
      "MAXFORGE_EDIT_HISTORY_MAX_AGE_DAYS",
      DEFAULT_MAX_AGE_DAYS
    ),
  };
}

function parseSessionHeader(raw: unknown, path: string): SessionHeaderRecord {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.record !== "session" ||
    !isProjectIdentity(raw.project) ||
    !isPatchInfo(raw.patch) ||
    typeof raw.startedAt !== "string" ||
    !isBaseline(raw.baseline)
  ) {
    throw new Error("invalid session header");
  }
  validateTimestamp(raw.startedAt, `session header ${path}`);
  return raw as unknown as SessionHeaderRecord;
}

function parseObservationRecord(
  raw: unknown,
  header: SessionHeaderRecord,
  path: string,
  line: number
): MaxforgeRetainedEditObservation | undefined {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.record !== "observation" ||
    !positiveSafeInteger(raw.sequence) ||
    !positiveSafeInteger(raw.sessionSequence) ||
    typeof raw.observedAt !== "string" ||
    !isEditObservedEvent(raw.event) ||
    raw.event.patcherId !== header.patch.patcherId ||
    raw.event.scope !== header.patch.scope
  ) {
    return undefined;
  }
  try {
    validateTimestamp(raw.observedAt, `observation ${path}:${line}`);
  } catch {
    return undefined;
  }
  return {
    sequence: raw.sequence,
    sessionSequence: raw.sessionSequence,
    sessionId: header.patch.sessionId,
    instanceId: header.patch.instanceId,
    sessionStartedAt: header.startedAt,
    sessionBaseline: header.baseline,
    observedAt: raw.observedAt,
    event: raw.event,
  };
}

function isMetadataRecord(
  raw: unknown,
  header: SessionHeaderRecord
): raw is MetadataRecord {
  return isRecord(raw) &&
    raw.schemaVersion === 1 &&
    raw.record === "metadata" &&
    raw.reason === "saved" &&
    typeof raw.observedAt === "string" &&
    Number.isFinite(Date.parse(raw.observedAt)) &&
    isPatchInfo(raw.patch) &&
    raw.patch.patcherId === header.patch.patcherId &&
    raw.patch.scope === header.patch.scope &&
    raw.patch.sessionId === header.patch.sessionId &&
    raw.patch.instanceId === header.patch.instanceId;
}

function isProjectIdentity(value: unknown): value is ProjectIdentity {
  return isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length <= 128 &&
    IDENTIFIER_PATTERN.test(value.id) &&
    (value.name === undefined || typeof value.name === "string");
}

function isPatchInfo(value: unknown): value is MaxforgePatchInfo {
  return isRecord(value) &&
    typeof value.patcherId === "string" && IDENTIFIER_PATTERN.test(value.patcherId) &&
    typeof value.scope === "string" && IDENTIFIER_PATTERN.test(value.scope) &&
    typeof value.instanceId === "string" && IDENTIFIER_PATTERN.test(value.instanceId) &&
    typeof value.sessionId === "string" && SESSION_ID_PATTERN.test(value.sessionId) &&
    (value.revision === null || typeof value.revision === "string") &&
    typeof value.controller === "boolean" &&
    typeof value.title === "string" &&
    typeof value.filename === "string" &&
    typeof value.filepath === "string" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string");
}

function isBaseline(value: unknown): value is MaxforgeObservationBaseline {
  return isRecord(value) &&
    typeof value.structureToken === "string" &&
    STRUCTURE_TOKEN_PATTERN.test(value.structureToken) &&
    isSnapshot(value.patcher);
}

function isEditObservedEvent(value: unknown): value is MaxforgeEditObservedEvent {
  const allowedCauses = new Set(["patcher", "box", "line", "attribute", "unknown"]);
  return isRecord(value) &&
    value.type === "maxforge.edit.observed" &&
    typeof value.patcherId === "string" &&
    typeof value.scope === "string" &&
    typeof value.structureToken === "string" &&
    STRUCTURE_TOKEN_PATTERN.test(value.structureToken) &&
    Array.isArray(value.causes) &&
    0 < value.causes.length &&
    value.causes.length <= allowedCauses.size &&
    value.causes.every((cause) =>
      typeof cause === "string" && allowedCauses.has(cause)
    ) &&
    new Set(value.causes).size === value.causes.length &&
    isSnapshot(value.patcher);
}

function isSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.filename === "string" &&
    typeof value.filepath === "string" &&
    typeof value.dirty === "boolean" &&
    typeof value.locked === "boolean" &&
    typeof value.presentation === "boolean" &&
    Array.isArray(value.boxes) &&
    value.boxes.every(isSnapshotBox) &&
    Array.isArray(value.connections) &&
    value.connections.every(isSnapshotConnection);
}

function isSnapshotBox(value: unknown): boolean {
  return isRecord(value) &&
    isStringArray(value.targetPath) &&
    typeof value.runtimeId === "string" && value.runtimeId.length > 0 &&
    typeof value.varName === "string" &&
    typeof value.maxclass === "string" &&
    isRectangle(value.patchingRect) &&
    typeof value.managed === "boolean" &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.comment === undefined || typeof value.comment === "string") &&
    isSnapshotAttributes(value.attributes);
}

function isSnapshotConnection(value: unknown): boolean {
  return isRecord(value) &&
    isStringArray(value.targetPath) &&
    isSnapshotEndpoint(value.source) &&
    isSnapshotEndpoint(value.destination) &&
    isSnapshotAttributes(value.attributes);
}

function isSnapshotEndpoint(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.runtimeId === "string" && value.runtimeId.length > 0 &&
    typeof value.varName === "string" &&
    typeof value.port === "number" &&
    Number.isSafeInteger(value.port) &&
    0 <= value.port;
}

function isSnapshotAttributes(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([name, attribute]) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && isPatchSetValue(attribute)
  );
}

function isPatchSetValue(value: unknown): boolean {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) &&
      0 < value.length &&
      value.length <= 256 &&
      value.every((entry) =>
      typeof entry === "string" ||
      (typeof entry === "number" && Number.isFinite(entry))
      ));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRectangle(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function validatePatchInfo(patch: MaxforgePatchInfo): void {
  if (!isPatchInfo(patch)) throw new Error("Invalid edit-history patch identity");
}

function validateBaseline(baseline: MaxforgeObservationBaseline): void {
  if (!isBaseline(baseline)) throw new Error("Invalid edit-history session baseline");
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label} timestamp`);
}

function metadataFromPatch(
  projectId: string,
  patch: MaxforgePatchInfo,
  observedAt: string,
  reason: PersistedPatchMetadata["reason"]
): PersistedPatchMetadata {
  return {
    projectId,
    patcherId: patch.patcherId,
    scope: patch.scope,
    instanceId: patch.instanceId,
    sessionId: patch.sessionId,
    observedAt,
    reason,
    title: patch.title,
    filename: patch.filename,
    filepath: patch.filepath,
  };
}

function deduplicateObservations(
  observations: readonly MaxforgeRetainedEditObservation[],
  warnings: string[]
): MaxforgeRetainedEditObservation[] {
  const result: MaxforgeRetainedEditObservation[] = [];
  const sessionEntries = new Set<string>();
  const globalSequences = new Map<number, string>();
  for (const observation of observations) {
    const key = `${observation.sessionId}\u0000${observation.sessionSequence}`;
    if (sessionEntries.has(key)) continue;
    sessionEntries.add(key);
    const previous = globalSequences.get(observation.sequence);
    if (previous && previous !== key) {
      warnings.push(
        `duplicate global edit sequence ${observation.sequence}; concurrent project writers may be active`
      );
    } else {
      globalSequences.set(observation.sequence, key);
    }
    result.push(observation);
  }
  return result;
}

function targetKey(patcherId: string, scope: string): string {
  return `${patcherId}\u0000${scope}`;
}

function identityFromKey(key: string): MaxforgePatchHistoryIdentity {
  const separator = key.indexOf("\u0000");
  if (separator < 0) throw new Error("Invalid patch history identity key");
  return {
    patcherId: key.slice(0, separator),
    scope: key.slice(separator + 1),
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && 0 < value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  return positiveInteger(Number(value), name);
}

function numberEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  return positiveNumber(Number(value), name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function parseWriterLease(source: string): WriterLease | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.projectId !== "string" ||
    !Number.isSafeInteger(raw.pid) ||
    (raw.pid as number) <= 0 ||
    typeof raw.token !== "string" ||
    raw.token.length === 0 ||
    typeof raw.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(raw.acquiredAt))
  ) return undefined;
  return raw as unknown as WriterLease;
}

function removeEmptyDirectory(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    if (
      isRecord(error) &&
      (error.code === "ENOENT" || error.code === "ENOTEMPTY")
    ) return error.code === "ENOENT";
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
