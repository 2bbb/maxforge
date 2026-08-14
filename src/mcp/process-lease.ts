import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

interface ProcessLeaseRecord {
  readonly schemaVersion: 1;
  readonly identity: string;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

export interface ProcessLeaseStatus {
  readonly state:
    | "unlocked"
    | "owned"
    | "held_by_other_process"
    | "stale"
    | "malformed";
  readonly path: string;
  readonly identity: string | null;
  readonly pid: number | null;
  readonly acquiredAt: string | null;
}

export class ProcessLease {
  readonly path: string;
  private token: string | undefined;

  constructor(path: string, private readonly identity: string) {
    this.path = resolve(path);
  }

  acquire(): void {
    if (this.token) throw new Error(`Process lease is already held: ${this.path}`);
    mkdirSync(dirname(this.path), { recursive: true });
    let existing: ProcessLeaseRecord | undefined;
    try {
      existing = parseProcessLease(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (existing) {
      if (
        existing.identity !== this.identity ||
        processIsAlive(existing.pid)
      ) {
        throw new Error(
          `Broker owner lease is active or cannot be validated: ${this.path}`
        );
      }
      this.quarantineDeadOwner(existing);
    } else if (existsWithoutValidRecord(this.path)) {
      throw new Error(
        `Broker owner lease is active or cannot be validated: ${this.path}`
      );
    }
    this.createLease();
  }

  release(): void {
    const token = this.token;
    if (!token) return;
    this.token = undefined;
    try {
      const record = parseProcessLease(readFileSync(this.path, "utf8"));
      if (record?.token === token) rmSync(this.path, { force: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }

  status(): ProcessLeaseStatus {
    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return {
          state: "unlocked",
          path: this.path,
          identity: null,
          pid: null,
          acquiredAt: null,
        };
      }
      throw error;
    }
    const record = parseProcessLease(source);
    if (!record) {
      return {
        state: "malformed",
        path: this.path,
        identity: null,
        pid: null,
        acquiredAt: null,
      };
    }
    const state = record.token === this.token
      ? "owned"
      : processIsAlive(record.pid)
        ? "held_by_other_process"
        : "stale";
    return {
      state,
      path: this.path,
      identity: record.identity,
      pid: record.pid,
      acquiredAt: record.acquiredAt,
    };
  }

  private createLease(): void {
    const token = randomUUID();
    const source = `${JSON.stringify({
      schemaVersion: 1,
      identity: this.identity,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    })}\n`;
    const descriptor = openSync(this.path, "wx", 0o600);
    let writeError: unknown;
    try {
      writeFileSync(descriptor, source, "utf8");
    } catch (error) {
      writeError = error;
    }
    try {
      closeSync(descriptor);
    } catch (error) {
      writeError = writeError === undefined
        ? error
        : new AggregateError(
          [writeError, error],
          `Broker owner lease write and close both failed: ${this.path}`
        );
    }
    if (writeError !== undefined) {
      try {
        rmSync(this.path, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [writeError, cleanupError],
          `Broker owner lease creation and cleanup both failed: ${this.path}`
        );
      }
      throw writeError;
    }
    this.token = token;
  }

  private quarantineDeadOwner(record: ProcessLeaseRecord): void {
    const quarantine = `${this.path}.stale-${randomUUID()}`;
    const current = parseProcessLease(readFileSync(this.path, "utf8"));
    if (current?.token !== record.token) {
      throw new Error(`Broker owner lease changed during recovery: ${this.path}`);
    }
    renameSync(this.path, quarantine);
    rmSync(quarantine, { force: true });
  }
}

function parseProcessLease(source: string): ProcessLeaseRecord | undefined {
  try {
    const value = JSON.parse(source) as Partial<ProcessLeaseRecord>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.identity !== "string" ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      typeof value.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(value.acquiredAt))
    ) return undefined;
    return value as ProcessLeaseRecord;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function existsWithoutValidRecord(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}
