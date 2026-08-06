import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import { compileDslToPatchGraph } from "../src/max/patch-graph.js";
import {
  JsonFilePatchStateStore,
  stateFileFromEnvironment,
} from "../src/mcp/state-store.js";

const database = dbData as ObjectDatabase;

describe("JsonFilePatchStateStore", () => {
  it("atomically round-trips graph, baseline, and pending apply state", () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-state-"));
    const path = join(directory, "state.json");
    const store = new JsonFilePatchStateStore(path);
    const graph = compileDslToPatchGraph(
      "osc = cycle~ 440",
      database,
      "voices"
    ).graph!;
    const snapshot = {
      title: "Voices",
      filename: "voices.maxpat",
      filepath: "/tmp/voices.maxpat",
      dirty: false,
      locked: false,
      presentation: false,
      boxes: [],
      connections: [],
    };

    store.save({
      managedGraphs: new Map([["patch-a:voices", graph]]),
      intentGraphs: new Map([["patch-a:voices", graph]]),
      baselineSnapshots: new Map([["patch-a:voices", snapshot]]),
      pendingApplies: new Map([[
        "patch-b:voices",
        { baseRevision: graph.revision, nextGraph: graph, intentGraph: graph },
      ]]),
    });

    const restored = store.load()!;
    expect(restored.managedGraphs.get("patch-a:voices")).toEqual(graph);
    expect(restored.baselineSnapshots.get("patch-a:voices")).toEqual(snapshot);
    expect(restored.pendingApplies.get("patch-b:voices")?.nextGraph).toEqual(graph);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("rejects state whose graph revision was tampered with", () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-state-"));
    const path = join(directory, "state.json");
    const graph = compileDslToPatchGraph("n = number", database, "main").graph!;
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      managedGraphs: [{ target: "patch:main", value: { ...graph, revision: "0".repeat(64) } }],
      intentGraphs: [],
      baselineSnapshots: [],
      pendingApplies: [],
    }));

    expect(() => new JsonFilePatchStateStore(path).load()).toThrow(
      "revision mismatch"
    );
  });

  it("upgrades persisted v1 snapshots that predate attribute inspection", () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-state-"));
    const path = join(directory, "state.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      managedGraphs: [],
      intentGraphs: [],
      baselineSnapshots: [{
        target: "patch:main",
        value: {
          title: "Legacy",
          filename: "",
          filepath: "",
          dirty: false,
          locked: false,
          presentation: false,
          boxes: [{
            targetPath: [],
            runtimeId: "obj-1",
            varName: "maxforge_main_obj_button",
            maxclass: "button",
            patchingRect: [0, 0, 24, 24],
            managed: true,
          }],
          connections: [],
        },
      }],
      pendingApplies: [],
    }));

    const restored = new JsonFilePatchStateStore(path).load()!;
    expect(restored.baselineSnapshots.get("patch:main")?.boxes[0].attributes)
      .toEqual({});
  });

  it("uses a per-port default and supports explicit disable or override", () => {
    expect(stateFileFromEnvironment({}, 8766)).toMatch(/mcp-state-8766-v1\.json$/);
    expect(stateFileFromEnvironment({ MAXFORGE_STATE_FILE: "off" }, 8766)).toBeUndefined();
    expect(stateFileFromEnvironment({ MAXFORGE_STATE_FILE: "/tmp/custom.json" }, 8766))
      .toBe("/tmp/custom.json");
  });
});
