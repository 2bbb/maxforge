import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import { compileDslToPatchGraph } from "../src/max/dsl-patch-graph.js";
import {
  JsonFilePatchStateStore,
  legacyStateFileFromEnvironment,
  stateFileFromEnvironment,
} from "../src/mcp/state-store.js";
import { DslPatchAdapter } from "../src/mcp/dsl-patch-adapter.js";

const database = dbData as unknown as ObjectDatabase;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix = "maxforge-state-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("JsonFilePatchStateStore", () => {
  it("atomically round-trips graph, baseline, and pending apply state", () => {
    const directory = temporaryDirectory();
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
      workingSources: new Map([["patch-a:voices", "osc = cycle~ 440"]]),
      intentSources: new Map([["patch-a:voices", "osc = cycle~ 440"]]),
      baselineSnapshots: new Map([["patch-a:voices", snapshot]]),
      pendingApplies: new Map([[
        "patch-b:voices",
        {
          baseRevision: graph.revision,
          nextGraph: graph,
          intentGraph: graph,
          nextSource: "osc = cycle~ 440",
          intentSource: "osc = cycle~ 440",
          recoveryBaseGraph: graph,
          recoveryBaseSource: "osc = cycle~ 440",
          superseded: {
            baseRevision: graph.revision,
            nextGraph: graph,
            intentGraph: graph,
            nextSource: "osc = cycle~ 440",
            intentSource: "osc = cycle~ 440",
          },
        },
      ]]),
    });

    const restored = store.load()!;
    expect(restored.managedGraphs.get("patch-a:voices")).toEqual(graph);
    expect(restored.workingSources.get("patch-a:voices")).toBe("osc = cycle~ 440");
    expect(restored.baselineSnapshots.get("patch-a:voices")).toEqual(snapshot);
    expect(restored.pendingApplies.get("patch-b:voices")?.nextGraph).toEqual(graph);
    expect(restored.pendingApplies.get("patch-b:voices")?.recoveryBaseGraph)
      .toEqual(graph);
    expect(restored.pendingApplies.get("patch-b:voices")?.superseded?.nextGraph)
      .toEqual(graph);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schemaVersion: 2 });
  });

  it("rejects state whose graph revision was tampered with", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "state.json");
    const graph = compileDslToPatchGraph("n = number", database, "main").graph!;
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      managedGraphs: [{ target: "patch:main", value: { ...graph, revision: "0".repeat(64) } }],
      intentGraphs: [],
      workingSources: [],
      intentSources: [],
      baselineSnapshots: [],
      pendingApplies: [],
    }));

    expect(() => new JsonFilePatchStateStore(path).load()).toThrow(
      "revision mismatch"
    );
  });

  it("rejects persisted snapshots that predate attribute inspection", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "state.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      managedGraphs: [],
      intentGraphs: [],
      workingSources: [],
      intentSources: [],
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

    expect(() => new JsonFilePatchStateStore(path).load()).toThrow(
      "Invalid baselineSnapshots snapshot for patch:main"
    );
  });

  it("atomically migrates default v1 state to lossless v2 sources", () => {
    const directory = temporaryDirectory("maxforge-state-migration-");
    const legacyPath = join(directory, "mcp-state-v1.json");
    const path = join(directory, "mcp-state-v2.json");
    const graph = compileDslToPatchGraph(
      "osc = cycle~ 440 at(10, 20)",
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
    writeFileSync(legacyPath, JSON.stringify({
      schemaVersion: 1,
      managedGraphs: [{ target: "patch-a:voices", value: graph }],
      intentGraphs: [{ target: "patch-a:voices", value: graph }],
      baselineSnapshots: [{ target: "patch-a:voices", value: snapshot }],
      pendingApplies: [{
        target: "patch-b:voices",
        value: {
          baseRevision: graph.revision,
          nextGraph: graph,
          intentGraph: graph,
          recoveryBaseGraph: graph,
          superseded: {
            baseRevision: graph.revision,
            nextGraph: graph,
            intentGraph: graph,
          },
        },
      }],
    }));
    const adapter = new DslPatchAdapter(database);
    const store = new JsonFilePatchStateStore(path, {
      legacyPath,
      serializeGraph: (value) => adapter.serialize(value),
    });

    const restored = store.load()!;

    expect(restored.managedGraphs.get("patch-a:voices")).toEqual(graph);
    expect(restored.workingSources.get("patch-a:voices"))
      .toContain("osc = cycle~ 440");
    expect(restored.intentSources.get("patch-a:voices"))
      .toContain("osc = cycle~ 440");
    expect(restored.pendingApplies.get("patch-b:voices")).toMatchObject({
      nextSource: expect.stringContaining("osc = cycle~ 440"),
      intentSource: expect.stringContaining("osc = cycle~ 440"),
      recoveryBaseSource: expect.stringContaining("osc = cycle~ 440"),
      superseded: {
        nextSource: expect.stringContaining("osc = cycle~ 440"),
        intentSource: expect.stringContaining("osc = cycle~ 440"),
      },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schemaVersion: 2,
    });
    expect(existsSync(legacyPath)).toBe(true);
  });

  it("fails explicitly instead of discarding an unrepresentable v1 state", () => {
    const directory = temporaryDirectory("maxforge-state-migration-");
    const legacyPath = join(directory, "mcp-state-v1.json");
    const path = join(directory, "mcp-state-v2.json");
    const graph = compileDslToPatchGraph("n = number", database, "main").graph!;
    writeFileSync(legacyPath, JSON.stringify({
      schemaVersion: 1,
      managedGraphs: [{ target: "patch:main", value: graph }],
      intentGraphs: [],
      baselineSnapshots: [],
      pendingApplies: [],
    }));
    const store = new JsonFilePatchStateStore(path, {
      legacyPath,
      serializeGraph: () => {
        throw new Error("synthetic lossless conversion failure");
      },
    });

    expect(() => store.load()).toThrow(
      /Cannot migrate legacy maxforge state.*synthetic lossless conversion failure/
    );
    expect(existsSync(path)).toBe(false);
  });

  it("uses project identity when available and supports disable or override", () => {
    expect(stateFileFromEnvironment({}, 8766)).toMatch(/mcp-state-8766-v2\.json$/);
    expect(stateFileFromEnvironment({}, 8766, "studio_patchset")).toMatch(
      /projects\/studio_patchset\/mcp-state-v2\.json$/
    );
    expect(stateFileFromEnvironment({ MAXFORGE_STATE_FILE: "off" }, 8766)).toBeUndefined();
    expect(stateFileFromEnvironment({ MAXFORGE_STATE_FILE: "/tmp/custom.json" }, 8766))
      .toBe("/tmp/custom.json");
    expect(legacyStateFileFromEnvironment({}, 8766)).toMatch(
      /mcp-state-8766-v1\.json$/
    );
    expect(legacyStateFileFromEnvironment({}, 8766, "studio_patchset")).toMatch(
      /projects\/studio_patchset\/mcp-state-v1\.json$/
    );
    expect(legacyStateFileFromEnvironment({ MAXFORGE_STATE_FILE: "off" }, 8766))
      .toBeUndefined();
    expect(legacyStateFileFromEnvironment({
      MAXFORGE_STATE_FILE: "/tmp/custom.json",
    }, 8766)).toBeUndefined();
  });
});
