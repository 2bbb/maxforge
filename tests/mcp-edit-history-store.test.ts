import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MaxforgeEditObservedEvent,
  MaxforgeObservationBaseline,
  MaxforgePatchInfo,
} from "../src/max/patch-protocol.js";
import {
  editHistoryDirectoryFromEnvironment,
  JsonLinesEditHistoryStore,
} from "../src/mcp/edit-history-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("JsonLinesEditHistoryStore", () => {
  it("restores ordered session observations from append-only NDJSON", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset", name: "Studio Patchset" },
    });
    const patch = patchInfo();
    const baseline = observationBaseline();
    store.load();
    store.startSession(patch, baseline, "2026-08-11T00:00:00.000Z");
    store.appendObservation({
      sequence: 41,
      sessionSequence: 1,
      sessionId: patch.sessionId,
      instanceId: patch.instanceId,
      sessionStartedAt: "2026-08-11T00:00:00.000Z",
      sessionBaseline: baseline,
      observedAt: "2026-08-11T00:00:01.000Z",
      event: observedEvent(),
    });

    const restored = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset", name: "Renamed display" },
    }).load();

    expect(restored.nextSequence).toBe(42);
    expect(restored.observations).toHaveLength(1);
    expect(restored.observations[0]).toMatchObject({
      sequence: 41,
      sessionSequence: 1,
      sessionId: "session-a",
      instanceId: "instance-a",
      sessionBaseline: { structureToken: "0".repeat(16) },
      event: { structureToken: "1".repeat(16) },
    });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(historyFiles(directory)[0]).mode & 0o777).toBe(0o600);
  });

  it("ignores a torn final record and reports the recovery warning", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    const patch = patchInfo();
    store.load();
    store.startSession(
      patch,
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );
    const path = historyFiles(directory)[0];
    appendFileSync(path, '{"schemaVersion":1,"record":"observation"', "utf8");

    const recovered = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    const result = recovered.load();

    expect(result.observations).toEqual([]);
    expect(recovered.status().warnings.join(" ")).toContain("incomplete final record");
  });

  it("records a saved filepath as a locator without changing patch identity", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    const unsaved = { ...patchInfo(), filename: "", filepath: "" };
    store.load();
    store.startSession(
      unsaved,
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );
    store.recordPatchMetadata({
      ...unsaved,
      filename: "voices.maxpat",
      filepath: "/project/patchers/voices.maxpat",
    }, "2026-08-11T00:00:02.000Z", "saved");

    const restored = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    restored.load();
    const metadata = restored.patchMetadata("patch-a", "voices");

    expect(metadata.at(-1)).toMatchObject({
      projectId: "studio_patchset",
      patcherId: "patch-a",
      scope: "voices",
      instanceId: "instance-a",
      sessionId: "session-a",
      reason: "saved",
      filepath: "/project/patchers/voices.maxpat",
    });
  });

  it("surfaces one saved path associated with multiple patch identities", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    store.startSession(
      patchInfo(),
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );
    store.startSession({
      ...patchInfo(),
      patcherId: "patch-b",
      instanceId: "instance-b",
      sessionId: "session-b",
    }, observationBaseline(), "2026-08-11T00:00:01.000Z");

    expect(store.status().warnings.join(" ")).toContain(
      "associated with multiple patch identities"
    );
  });

  it("rekeys history to a new logical patch identity without rewriting evidence", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    store.startSession(
      patchInfo(),
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );

    const result = store.resolvePatchIdentity({
      action: "rekey",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-a", scope: "voices" },
      target: { patcherId: "patch-renamed", scope: "voices" },
      reason: "Renamed maxforge.sync patcherId after saving the project",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    });

    expect(result.canonical).toEqual({
      patcherId: "patch-renamed",
      scope: "voices",
    });
    expect(store.patchMetadata("patch-renamed", "voices")).toEqual([
      expect.objectContaining({ patcherId: "patch-a", scope: "voices" }),
    ]);
    expect(store.matchesPatchIdentity(
      "patch-a",
      "voices",
      "patch-renamed",
      "voices"
    )).toBe(true);

    const restored = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    restored.load();
    expect(restored.patchIdentity("patch-renamed", "voices")).toMatchObject({
      known: true,
      forgotten: false,
      aliases: [{ patcherId: "patch-a", scope: "voices" }],
    });
  });

  it("ignores replayed decisions that mutate an identity through an old alias", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    store.startSession(
      patchInfo(),
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );
    store.resolvePatchIdentity({
      action: "rekey",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-a", scope: "voices" },
      target: { patcherId: "patch-renamed", scope: "voices" },
      reason: "Renamed the logical patch identity",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    });
    appendFileSync(
      join(directory, "identity-resolutions-v1.ndjson"),
      `${JSON.stringify({
        schemaVersion: 1,
        record: "identity-resolution",
        action: "rekey",
        source: { patcherId: "patch-a", scope: "voices" },
        target: { patcherId: "patch-corrupted", scope: "voices" },
        reason: "Semantically invalid replay through an old alias",
        resolvedAt: "2026-08-11T00:00:04.000Z",
      })}\n`,
      "utf8"
    );

    const restored = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    restored.load();

    expect(restored.patchIdentity("patch-renamed", "voices")).toMatchObject({
      canonical: { patcherId: "patch-renamed", scope: "voices" },
      aliases: [{ patcherId: "patch-a", scope: "voices" }],
    });
    expect(restored.status().warnings.join(" ")).toContain("already an alias");
  });

  it("merges explicitly duplicated identities and clears resolved path ambiguity", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    store.startSession(
      patchInfo(),
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );
    store.startSession({
      ...patchInfo(),
      patcherId: "patch-b",
      instanceId: "instance-b",
      sessionId: "session-b",
    }, observationBaseline(), "2026-08-11T00:00:01.000Z");
    expect(store.status().warnings.join(" ")).toContain(
      "associated with multiple patch identities"
    );

    store.resolvePatchIdentity({
      action: "merge",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-b", scope: "voices" },
      target: { patcherId: "patch-a", scope: "voices" },
      reason: "Confirmed that patch-b was an accidental duplicate identity",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    });

    expect(store.patchMetadata("patch-a", "voices")).toHaveLength(2);
    expect(store.status().warnings.join(" ")).not.toContain(
      "associated with multiple patch identities"
    );
  });

  it("forgets one logical history group without claiming physical erasure", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    store.startSession(
      patchInfo(),
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );

    const result = store.resolvePatchIdentity({
      action: "forget",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-a", scope: "voices" },
      reason: "This patch identity belongs to a discarded experiment",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    });

    expect(result).toMatchObject({ forgotten: true, physicalDataErased: false });
    expect(store.patchMetadata("patch-a", "voices")).toEqual([]);
    expect(store.matchesPatchIdentity(
      "patch-a",
      "voices",
      "patch-a",
      "voices"
    )).toBe(false);
    expect(historyFiles(directory)).not.toEqual([]);
  });

  it("physically deletes only owned project history after exact confirmation", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    store.startSession(
      patchInfo(),
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );
    store.resolvePatchIdentity({
      action: "rekey",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-a", scope: "voices" },
      target: { patcherId: "patch-renamed", scope: "voices" },
      reason: "Create an identity ledger before erasure",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    });
    const unrelated = join(directory, "keep-me.txt");
    writeFileSync(unrelated, "not maxforge history\n", "utf8");

    expect(() => store.eraseProjectHistory(
      "studio_patchset",
      "erase it"
    )).toThrow("exact confirmation");
    expect(historyFiles(directory)).toHaveLength(2);

    const erased = store.eraseProjectHistory(
      "studio_patchset",
      "ERASE PROJECT HISTORY studio_patchset"
    );

    expect(erased).toMatchObject({
      projectId: "studio_patchset",
      location: directory,
      filesDeleted: 2,
      directoryRemoved: false,
    });
    expect(erased.bytesDeleted).toBeGreaterThan(0);
    expect(historyFiles(directory)).toEqual([]);
    expect(statSync(unrelated).isFile()).toBe(true);
    expect(store.patchIdentity("patch-renamed", "voices")).toMatchObject({
      known: false,
      forgotten: false,
      aliases: [],
      decisions: [],
    });
  });

  it("does not replace another writer lease and releases only its own", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });

    store.acquireWriterLease();
    expect(() => new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
      recoverStaleWriterLease: true,
    }).acquireWriterLease()).toThrow("active writer lease");
    store.releaseWriterLease();
  });

  it("atomically replaces a valid lease whose recorded process is dead", () => {
    const directory = temporaryDirectory();
    const leasePath = join(directory, "writer-v1.lock");
    writeFileSync(leasePath, `${JSON.stringify({
      schemaVersion: 1,
      projectId: "studio_patchset",
      pid: 2_147_483_647,
      token: "dead-writer",
      acquiredAt: "2026-08-14T00:00:00.000Z",
    })}\n`);
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
      recoverStaleWriterLease: true,
    });

    store.acquireWriterLease();

    expect(JSON.parse(readFileSync(leasePath, "utf8"))).toMatchObject({
      projectId: "studio_patchset",
      pid: process.pid,
    });
    expect(readdirSync(directory).filter((name) => name.includes(".stale-")))
      .toEqual([]);
    store.releaseWriterLease();
  });

  it("rejects unsafe or ambiguous identity resolutions", () => {
    const directory = temporaryDirectory();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    store.startSession(
      patchInfo(),
      observationBaseline(),
      "2026-08-11T00:00:00.000Z"
    );

    expect(() => store.resolvePatchIdentity({
      action: "merge",
      expectedProjectId: "wrong-project",
      source: { patcherId: "patch-a", scope: "voices" },
      target: { patcherId: "patch-b", scope: "voices" },
      reason: "Wrong namespace",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    })).toThrow("project id");
    expect(() => store.resolvePatchIdentity({
      action: "rekey",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-a", scope: "voices" },
      target: { patcherId: "patch-b", scope: "meters" },
      reason: "Unsafe scope migration",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    })).toThrow("same scope");
    expect(() => store.resolvePatchIdentity({
      action: "merge",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-a", scope: "voices" },
      target: { patcherId: "missing", scope: "voices" },
      reason: "Target is not known",
      resolvedAt: "2026-08-11T00:00:03.000Z",
    })).toThrow("known target");
  });

  it("does not invent a shared project cache without project identity", () => {
    expect(editHistoryDirectoryFromEnvironment({}, undefined)).toBeUndefined();
    expect(editHistoryDirectoryFromEnvironment(
      { MAXFORGE_EDIT_HISTORY: "off" },
      { id: "studio_patchset" }
    )).toBeUndefined();
    expect(editHistoryDirectoryFromEnvironment(
      { MAXFORGE_EDIT_HISTORY_DIR: "/tmp/maxforge-history" },
      { id: "studio_patchset" }
    )).toBe("/tmp/maxforge-history");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "maxforge-edit-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

function historyFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function patchInfo(): MaxforgePatchInfo {
  return {
    patcherId: "patch-a",
    scope: "voices",
    instanceId: "instance-a",
    sessionId: "session-a",
    revision: null,
    controller: false,
    title: "Patch A",
    filename: "patch-a.maxpat",
    filepath: "/project/patch-a.maxpat",
    externalVersion: "0.4.0",
    versionCompatible: true,
    capabilities: ["edit_observation_v1", "session_baseline_v1"],
  };
}

function observationBaseline(): MaxforgeObservationBaseline {
  return {
    structureToken: "0".repeat(16),
    patcher: snapshot(),
  };
}

function observedEvent(): MaxforgeEditObservedEvent {
  return {
    type: "maxforge.edit.observed",
    patcherId: "patch-a",
    scope: "voices",
    revision: null,
    structureToken: "1".repeat(16),
    causes: ["box"],
    patcher: snapshot(),
  };
}

function snapshot() {
  return {
    title: "Patch A",
    filename: "patch-a.maxpat",
    filepath: "/project/patch-a.maxpat",
    dirty: true,
    locked: false,
    presentation: false,
    boxes: [],
    connections: [],
  };
}
