import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessLease } from "../src/mcp/process-lease.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProcessLease", () => {
  it("reports ownership, excludes a live owner, and releases only its token", () => {
    const path = leasePath();
    const owner = new ProcessLease(path, "project:test");
    const contender = new ProcessLease(path, "project:test");
    expect(owner.status()).toMatchObject({ state: "unlocked", pid: null });

    owner.acquire();
    expect(owner.status()).toMatchObject({
      state: "owned",
      identity: "project:test",
      pid: process.pid,
    });
    expect(contender.status()).toMatchObject({
      state: "held_by_other_process",
      pid: process.pid,
    });
    expect(() => contender.acquire()).toThrow("active or cannot be validated");
    expect(() => owner.acquire()).toThrow("already held");

    contender.release();
    expect(existsSync(path)).toBe(true);
    owner.release();
    expect(owner.status().state).toBe("unlocked");
    owner.release();
  });

  it("recovers a valid dead owner and refuses foreign or malformed records", () => {
    const path = leasePath();
    writeLease(path, "project:test", "dead-owner");
    const replacement = new ProcessLease(path, "project:test");
    expect(replacement.status().state).toBe("stale");
    replacement.acquire();
    expect(replacement.status().state).toBe("owned");
    replacement.release();

    writeLease(path, "project:other", "foreign-owner");
    expect(() => new ProcessLease(path, "project:test").acquire())
      .toThrow("active or cannot be validated");

    writeFileSync(path, "not-json\n");
    const malformed = new ProcessLease(path, "project:test");
    expect(malformed.status()).toMatchObject({
      state: "malformed",
      identity: null,
      pid: null,
    });
    expect(() => malformed.acquire()).toThrow("active or cannot be validated");
  });

  it("does not delete a lease whose token changed before release", () => {
    const path = leasePath();
    const owner = new ProcessLease(path, "project:test");
    owner.acquire();
    writeLease(path, "project:test", "replacement-token", process.pid);
    owner.release();
    expect(existsSync(path)).toBe(true);
  });
});

function leasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "maxforge-process-lease-"));
  temporaryDirectories.push(directory);
  return join(directory, "owner.lock");
}

function writeLease(
  path: string,
  identity: string,
  token: string,
  pid = 99_999_999
): void {
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    identity,
    pid,
    token,
    acquiredAt: new Date(0).toISOString(),
  })}\n`);
}
