import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
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
