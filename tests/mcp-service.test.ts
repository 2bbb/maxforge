import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  CloseMaxPatchRequest,
  CreateMaxPatchRequest,
  MaxforgeAppliedEvent,
  MaxforgeBridgeStatus,
  MaxforgeEditObservationHistory,
  MaxforgePatchClosingEvent,
  MaxforgePatchInfo,
  MaxforgePatchSavedEvent,
  MaxforgePatcherSnapshot,
  MaxforgeSnapshotEvent,
  OpenMaxPatchRequest,
  PatchPlanTransport,
  SaveMaxPatchRequest,
} from "../src/max/patch-protocol.js";
import { MaxforgePatchService } from "../src/mcp/service.js";
import { diffPatcherSnapshots } from "../src/max/patch-snapshot.js";
import { DslPatchAdapter } from "../src/mcp/dsl-patch-adapter.js";
import {
  PatchServiceState,
  PatchStateStore,
} from "../src/mcp/state-store.js";
import { compileDslToPatchGraph } from "../src/max/dsl-patch-graph.js";
import { PatchGraph, PatchPlan, PatchSetValue } from "../src/max/patch-graph.js";
import { JsonLinesEditHistoryStore } from "../src/mcp/edit-history-store.js";

const database = dbData as ObjectDatabase;

function createService(
  transport: PatchPlanTransport,
  store?: PatchStateStore
): MaxforgePatchService {
  return new MaxforgePatchService(new DslPatchAdapter(database), transport, store);
}

describe("MaxforgePatchService", () => {
  it("turns retained observations into ordered evidence without claiming intent", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });
    const moved = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        patchingRect: [90, 50, 66, 22] as const,
      })),
    };
    const retuned = {
      ...moved,
      boxes: moved.boxes.map((box) => ({ ...box, text: "cycle~ 660" })),
    };
    transport.editHistory = {
      supported: true,
      droppedEvents: 0,
      persistence: disabledHistoryPersistence(),
      identity: null,
      patchMetadata: [],
      observations: [
        {
          sequence: 10,
          sessionSequence: 1,
          sessionId: "session-a",
          instanceId: "instance-a",
          sessionStartedAt: "2026-08-11T00:00:00.000Z",
          sessionBaseline: {
            structureToken: "0".repeat(16),
            patcher: transport.snapshot,
          },
          observedAt: "2026-08-11T00:00:00.000Z",
          event: {
            type: "maxforge.edit.observed",
            patcherId: "patch-a",
            scope: "voices",
            revision: transport.getLiveRevision("patch-a", "voices") ?? null,
            structureToken: "1".repeat(16),
            causes: ["box"],
            patcher: moved,
          },
        },
        {
          sequence: 11,
          sessionSequence: 2,
          sessionId: "session-a",
          instanceId: "instance-a",
          sessionStartedAt: "2026-08-11T00:00:00.000Z",
          sessionBaseline: {
            structureToken: "0".repeat(16),
            patcher: transport.snapshot,
          },
          observedAt: "2026-08-11T00:00:01.000Z",
          event: {
            type: "maxforge.edit.observed",
            patcherId: "patch-a",
            scope: "voices",
            revision: transport.getLiveRevision("patch-a", "voices") ?? null,
            structureToken: "2".repeat(16),
            causes: ["box", "attribute"],
            patcher: retuned,
          },
        },
      ],
    };

    const history = service.getLiveEditHistory("patch-a", "voices", 10);
    expect(history).toMatchObject({
      supported: true,
      droppedEvents: 0,
      latestSequence: 11,
      observations: [{
        sequence: 11,
        comparisonBasis: "previous_observation",
        causes: ["box", "attribute"],
        review: {
          signals: [expect.objectContaining({ kind: "object_configuration" })],
          interpretationGuidance: { mode: "evidence_only" },
        },
      }],
    });
    expect(history.limitations.join(" ")).toContain("not Max undo actions");
    expect(history.limitations.join(" ")).toContain("snapshot sent during registration");
  });

  it("marks the first retained comparison incomplete after history overflow", () => {
    const transport = new FakeTransport();
    transport.editHistory = {
      supported: true,
      droppedEvents: 3,
      persistence: disabledHistoryPersistence(),
      identity: null,
      patchMetadata: [],
      observations: [{
        sequence: 4,
        sessionSequence: 4,
        sessionId: "session-a",
        instanceId: "instance-a",
        sessionStartedAt: "2026-08-11T00:00:00.000Z",
        sessionBaseline: {
          structureToken: "0".repeat(16),
          patcher: transport.snapshot,
        },
        observedAt: "2026-08-11T00:00:00.000Z",
        event: {
          type: "maxforge.edit.observed",
          patcherId: "patch-a",
          scope: "voices",
          revision: null,
          structureToken: "4".repeat(16),
          causes: ["unknown"],
          patcher: transport.snapshot,
        },
      }],
    };
    const history = createService(transport)
      .getLiveEditHistory("patch-a", "voices");
    expect(history.observations[0].comparisonBasis)
      .toBe("incomplete_after_drop");
  });

  it("never compares observations across registration sessions", () => {
    const transport = new FakeTransport();
    const empty = { ...transport.snapshot, boxes: [] };
    const moved = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        patchingRect: [100, 20, 60, 22] as const,
      })),
    };
    transport.editHistory = {
      supported: true,
      droppedEvents: 0,
      persistence: disabledHistoryPersistence(),
      identity: null,
      patchMetadata: [],
      observations: [
        retainedObservation(1, 1, "session-old", transport.snapshot, empty),
        retainedObservation(2, 1, "session-new", transport.snapshot, moved),
      ],
    };

    const history = createService(transport)
      .getLiveEditHistory("patch-a", "voices");

    expect(history.observations[1]).toMatchObject({
      comparisonBasis: "session_baseline",
      changes: [{ kind: "box_changed", fields: ["patchingRect"] }],
    });
  });

  it("rejects history identity mutation while the source group is connected", () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-service-identity-"));
    try {
      const transport = new FakeTransport();
      const patch: MaxforgePatchInfo = {
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
      transport.patches = [patch];
      const store = new JsonLinesEditHistoryStore({
        directory,
        project: { id: "studio_patchset" },
      });
      store.load();
      store.startSession(patch, {
        structureToken: "0".repeat(16),
        patcher: transport.snapshot,
      }, "2026-08-13T00:00:00.000Z");
      const service = new MaxforgePatchService(
        new DslPatchAdapter(database),
        transport,
        undefined,
        store
      );

      expect(() => service.resolvePatchHistoryIdentity({
        action: "rekey",
        expectedProjectId: "studio_patchset",
        source: { patcherId: "patch-a", scope: "voices" },
        target: { patcherId: "patch-renamed", scope: "voices" },
        reason: "Attempted while Max is still connected",
      })).toThrow("is connected");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("erases disconnected project history from disk and retained memory", () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-service-erasure-"));
    try {
      const transport = new FakeTransport();
      transport.connectedClients = 0;
      transport.retainedHistoryCount = 3;
      const store = new JsonLinesEditHistoryStore({
        directory,
        project: { id: "studio_patchset" },
      });
      store.load();
      store.startSession({
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
      }, {
        structureToken: "0".repeat(16),
        patcher: transport.snapshot,
      }, "2026-08-13T00:00:00.000Z");
      const service = new MaxforgePatchService(
        new DslPatchAdapter(database),
        transport,
        undefined,
        store
      );

      expect(service.eraseProjectHistory({
        expectedProjectId: "studio_patchset",
        confirmation: "ERASE PROJECT HISTORY studio_patchset",
      })).toMatchObject({
        projectId: "studio_patchset",
        filesDeleted: 1,
        retainedObservationsCleared: 3,
        physicalDataDeleted: true,
        secureOverwriteGuaranteed: false,
      });
      expect(transport.retainedHistoryCount).toBe(0);
      expect(service.eraseProjectHistory({
        expectedProjectId: "studio_patchset",
        confirmation: "ERASE PROJECT HISTORY studio_patchset",
      })).toMatchObject({
        filesDeleted: 0,
        retainedObservationsCleared: 0,
        physicalDataDeleted: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects project history erasure while any Max client is connected", () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-service-erasure-"));
    try {
      const transport = new FakeTransport();
      const store = new JsonLinesEditHistoryStore({
        directory,
        project: { id: "studio_patchset" },
      });
      store.load();
      const service = new MaxforgePatchService(
        new DslPatchAdapter(database),
        transport,
        undefined,
        store
      );

      expect(() => service.eraseProjectHistory({
        expectedProjectId: "studio_patchset",
        confirmation: "ERASE PROJECT HISTORY studio_patchset",
      })).toThrow("while any Max WebSocket client is connected");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("advances remembered desired state only after Max acknowledges an apply", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);

    const first = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });
    const second = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440\nosc_1 = cycle~ 660",
    });

    expect(first.plan.operations.map((operation) => operation.op)).toEqual([
      "create",
    ]);
    expect(first.plan.baseStructureToken).toBe("0".repeat(16));
    expect(first.timings).toEqual({
      preflightMs: expect.any(Number),
      pendingStatePersistenceMs: expect.any(Number),
      nativeApplyMs: expect.any(Number),
      postApplyInspectionMs: expect.any(Number),
      finalStatePersistenceMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(first.timings.totalMs).toBeGreaterThanOrEqual(
      first.timings.nativeApplyMs
    );
    expect(second.plan.operations.map((operation) => operation.op)).toEqual([
      "create",
    ]);
    expect(second.plan.operations[0]).toMatchObject({
      op: "create",
      box: { id: "obj-osc_1" },
    });
    expect(service.getManagedRevisions()).toEqual({
      "patch-a:voices": second.plan.targetRevision,
    });
    expect(second.workingDsl).toContain("osc_1 = cycle~ 660");
  });

  it("rejects an incompatible native external before recording a pending apply", async () => {
    const transport = new FakeTransport();
    transport.patches = [{
      patcherId: "patch-a",
      scope: "voices",
      instanceId: "instance-a",
      sessionId: "session-a",
      revision: null,
      controller: false,
      title: "Patch A",
      filename: "patch-a.maxpat",
      filepath: "/project/patch-a.maxpat",
      externalVersion: "0.3.0",
      versionCompatible: false,
      capabilities: [],
    }];
    const service = createService(transport);

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    })).rejects.toThrow(
      'loaded maxforge.sync version "0.3.0", but this MCP runtime requires "0.4.0"'
    );
    expect(transport.plans).toEqual([]);
    expect(service.getStateStatus().pendingScopes).toEqual([]);
  });

  it("preserves compact authored DSL after an ordinary apply and restart", async () => {
    const transport = new FakeTransport();
    const store = new MemoryStateStore();
    const authoredDsl = [
      "for i in 0..63 {",
      "  voice_${i} = cycle~ ${110 + i * 2}",
      "}",
    ].join("\n");

    const applied = await createService(transport, store).applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: authoredDsl,
    });

    expect(applied.workingDsl).toBe(authoredDsl);
    expect(applied.workingDsl).toContain("for i in 0..63");
    expect(store.state?.workingSources.get("patch-a:voices")).toBe(authoredDsl);
    expect(store.state?.intentSources.get("patch-a:voices")).toBe(authoredDsl);

    const restarted = createService(transport, store);
    expect(restarted.getWorkingSources()).toEqual({
      "patch-a:voices": authoredDsl,
    });
  });

  it("reuses an explicitly inspected structure token and returns post-apply verification", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });
    const inspection = await service.inspectPatch("patch-a", "voices");
    const inspectionsBeforeApply = transport.inspectionCount;
    transport.snapshotAfterApply = snapshotForDsl(
      "osc = cycle~ 660 at(50, 50)",
      "voices"
    );

    const applied = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 660 at(50, 50)",
      expectedStructureToken: inspection.snapshot.structureToken,
    });

    expect(transport.inspectionCount).toBe(inspectionsBeforeApply + 1);
    expect(applied.verification).toEqual({
      revision: applied.plan.targetRevision,
      structureToken: "0".repeat(16),
      boxCount: 1,
      connectionCount: 0,
    });
  });

  it("compiles read-only plans against the same remembered state used by apply", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc_0 = cycle~ 440",
    });

    const preview = service.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc_0 = cycle~ 440\nosc_1 = cycle~ 660",
    });

    expect(preview.plan.operations).toHaveLength(1);
    expect(preview.plan.operations[0]).toMatchObject({
      op: "create",
      box: { id: "obj-osc_1" },
    });
  });

  it("does not advance remembered state when Max rejects the plan", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    transport.failure = new Error("rejected");

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    })).rejects.toThrow("rejected");

    expect(service.getManagedRevisions()).toEqual({});
  });

  it("requires current DSL after MCP restarts against initialized Max state", async () => {
    const transport = new FakeTransport();
    transport.liveRevisions.set("patch-a:voices", "a".repeat(64));
    const service = createService(transport);

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    })).rejects.toThrow("this MCP process has no graph state");
    expect(transport.plans).toHaveLength(0);
  });

  it("restores managed graph and inspection baseline across MCP restarts", async () => {
    const transport = new FakeTransport();
    const store = new MemoryStateStore();
    const firstService = createService(transport, store);
    const first = await firstService.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });

    const restarted = createService(transport, store);
    expect(restarted.getManagedRevisions()).toEqual({
      "patch-a:voices": first.plan.targetRevision,
    });
    expect(restarted.getBaselineScopes()).toEqual(["patch-a:voices"]);

    const preview = restarted.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440\ngain = *~ 0.5",
    });
    expect(preview.plan.operations).toEqual([
      expect.objectContaining({ op: "create", box: expect.objectContaining({ id: "obj-gain" }) }),
    ]);
  });

  it("recovers an acknowledged apply after the acknowledgement was lost", async () => {
    const transport = new FakeTransport();
    const store = new MemoryStateStore();
    const service = createService(transport, store);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });
    transport.failureAfterApply = new Error("acknowledgement lost");
    const uncertainDsl = "osc = cycle~ 440\ngain = *~ 0.5";

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: uncertainDsl,
    })).rejects.toThrow("acknowledgement lost");
    expect(store.state?.pendingApplies.size).toBe(1);

    transport.failureAfterApply = undefined;
    const restarted = createService(transport, store);
    const preview = restarted.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: `${uncertainDsl}\nmeter = meter~`,
    });
    expect(preview.plan.baseRevision).toBe(
      compileDslToPatchGraph(uncertainDsl, database, "voices").graph!.revision
    );
    expect(preview.plan.operations).toEqual([
      expect.objectContaining({ op: "create", box: expect.objectContaining({ id: "obj-meter" }) }),
    ]);
    expect(store.state?.pendingApplies.size).toBe(0);
  });

  it("explicitly rebases a stale pending apply onto an exact third live revision", async () => {
    const transport = new FakeTransport();
    const store = new MemoryStateStore();
    const service = createService(transport, store);
    const baseDsl = "osc = cycle~ 440";
    transport.snapshotAfterApply = snapshotForDsl(baseDsl, "voices");
    const initial = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: baseDsl,
    });
    expect(initial.baselineCaptured).toBe(true);

    const pendingDsl = `${baseDsl}\ngain = *~ 0.5`;
    transport.failureAfterApply = new Error("acknowledgement lost");
    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: pendingDsl,
    })).rejects.toThrow("acknowledgement lost");

    const liveDsl = `${baseDsl}\nmeter = meter~`;
    const liveGraph = compileDslToPatchGraph(liveDsl, database, "voices").graph!;
    transport.failureAfterApply = undefined;
    transport.liveRevisions.set("patch-a:voices", liveGraph.revision);
    transport.snapshot = snapshotForGraph(liveGraph);
    const restarted = createService(transport, store);

    const inspected = await restarted.inspectPendingApply("patch-a", "voices");
    expect(inspected).toMatchObject({
      baseRevision: store.state?.managedGraphs.get("patch-a:voices")?.revision,
      targetRevision: compileDslToPatchGraph(
        pendingDsl,
        database,
        "voices"
      ).graph!.revision,
      liveRevision: liveGraph.revision,
      structureToken: "0".repeat(16),
    });
    expect(inspected.targetWorkingDsl).toContain("gain = *~ 0.5");

    await expect(restarted.recoverPendingApply({
      patcherId: "patch-a",
      scope: "voices",
      action: "rebase_live",
      expectedLiveRevision: liveGraph.revision,
      expectedStructureToken: "f".repeat(16),
      currentDsl: liveDsl,
    })).rejects.toThrow("changed after pending-apply inspection");
    expect(store.state?.pendingApplies.size).toBe(1);

    const recovered = await restarted.recoverPendingApply({
      patcherId: "patch-a",
      scope: "voices",
      action: "rebase_live",
      expectedLiveRevision: liveGraph.revision,
      expectedStructureToken: inspected.structureToken,
      currentDsl: liveDsl,
    });
    expect(recovered).toMatchObject({
      action: "rebase_live",
      managedRevision: liveGraph.revision,
    });
    expect(recovered.workingDsl).toContain("meter = meter~");
    expect(recovered.targetWorkingDsl).toContain("gain = *~ 0.5");
    expect(store.state?.pendingApplies.size).toBe(0);

    const next = restarted.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: `${liveDsl}\nbutton_1 = button`,
    });
    expect(next.plan.operations).toEqual([
      expect.objectContaining({
        op: "create",
        box: expect.objectContaining({ id: "obj-button_1" }),
      }),
    ]);
  });

  it("preserves both recovery and superseded apply evidence when recovery acknowledgement is lost", async () => {
    const transport = new FakeTransport();
    const store = new MemoryStateStore();
    const service = createService(transport, store);
    const baseDsl = "osc = cycle~ 440";
    transport.snapshotAfterApply = snapshotForDsl(baseDsl, "voices");
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: baseDsl,
    });

    const pendingDsl = `${baseDsl}\ngain = *~ 0.5`;
    transport.failureAfterApply = new Error("original acknowledgement lost");
    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: pendingDsl,
    })).rejects.toThrow("original acknowledgement lost");

    const liveDsl = `${baseDsl}\nmeter = meter~`;
    const liveGraph = compileDslToPatchGraph(liveDsl, database, "voices").graph!;
    transport.liveRevisions.set("patch-a:voices", liveGraph.revision);
    transport.snapshot = {
      ...snapshotForGraph(liveGraph),
      boxes: snapshotForGraph(liveGraph).boxes.map((box) =>
        box.varName?.endsWith("obj_meter")
          ? { ...box, patchingRect: [180, 120, 80, 22] }
          : box
      ),
    };

    transport.failureAfterApply = new Error("recovery acknowledgement lost");
    const firstRestart = createService(transport, store);
    const firstInspection = await firstRestart.inspectPendingApply(
      "patch-a",
      "voices"
    );
    await expect(firstRestart.recoverPendingApply({
      patcherId: "patch-a",
      scope: "voices",
      action: "rebase_live",
      expectedLiveRevision: firstInspection.liveRevision,
      expectedStructureToken: firstInspection.structureToken,
      currentDsl: liveDsl,
    })).rejects.toThrow("recovery acknowledgement lost");

    const recoveryRevision = transport.liveRevisions.get("patch-a:voices")!;
    expect(recoveryRevision).not.toBe(liveGraph.revision);
    expect(store.state?.pendingApplies.get("patch-a:voices")).toMatchObject({
      baseRevision: liveGraph.revision,
      nextGraph: { revision: recoveryRevision },
      recoveryBaseGraph: { revision: liveGraph.revision },
      superseded: {
        nextGraph: {
          revision: compileDslToPatchGraph(
            pendingDsl,
            database,
            "voices"
          ).graph!.revision,
        },
      },
    });

    const secondRestart = createService(transport, store);
    expect(() => secondRestart.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: `${liveDsl}\nbutton_1 = button`,
    })).toThrow("requires explicit maxforge_inspect_pending_apply");

    const secondInspection = await secondRestart.inspectPendingApply(
      "patch-a",
      "voices"
    );
    expect(secondInspection).toMatchObject({
      baseRevision: liveGraph.revision,
      targetRevision: recoveryRevision,
      liveRevision: recoveryRevision,
      liveState: "target",
      supersededApply: {
        targetRevision: compileDslToPatchGraph(
          pendingDsl,
          database,
          "voices"
        ).graph!.revision,
      },
    });
    expect(secondInspection.targetWorkingDsl).toContain("meter = meter~");
    expect(secondInspection.supersededApply?.targetWorkingDsl)
      .toContain("gain = *~ 0.5");

    transport.failureAfterApply = undefined;
    const recovered = await secondRestart.recoverPendingApply({
      patcherId: "patch-a",
      scope: "voices",
      action: "rebase_live",
      expectedLiveRevision: secondInspection.liveRevision,
      expectedStructureToken: secondInspection.structureToken,
      currentDsl: secondInspection.targetWorkingDsl,
    });
    expect(recovered).toMatchObject({
      managedRevision: recoveryRevision,
      revisionAdvanced: false,
    });
    expect(transport.plans).toHaveLength(3);
    expect(store.state?.pendingApplies.size).toBe(0);
  });

  it("rejects caller-provided current DSL when its revision differs from Max", async () => {
    const transport = new FakeTransport();
    transport.liveRevisions.set("patch-a:voices", "b".repeat(64));
    const service = createService(transport);

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      currentDsl: "osc = cycle~ 440",
      desiredDsl: "osc = cycle~ 880",
    })).rejects.toThrow("does not match Max patch");
    expect(transport.plans).toHaveLength(0);
  });

  it("reports DSL diagnostics without sending an invalid plan", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = object_that_does_not_exist",
    })).rejects.toThrow("[E003]");
    expect(transport.plans).toHaveLength(0);
  });

  it("reports exact structural changes without reading the screen", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        patchingRect: [120, 80, 66, 22],
      })),
    };

    const result = await service.inspectPatch("patch-a", "voices");

    expect(result).toMatchObject({
      comparisonAvailable: true,
      managedChangeCount: 1,
      unmanagedChangeCount: 0,
      changes: [{
        kind: "box_changed",
        managed: true,
        fields: ["patchingRect"],
        before: { patchingRect: [50, 50, 80, 22] },
        after: { patchingRect: [120, 80, 66, 22] },
      }],
    });
  });

  it("reports live comment, box attribute, and patch-cord attribute edits", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });
    const managed = transport.snapshot.boxes[0];
    const manual = {
      targetPath: [],
      runtimeId: "obj-manual",
      varName: "manual_button",
      maxclass: "button",
      patchingRect: [180, 50, 24, 24] as [number, number, number, number],
      managed: false,
      attributes: {},
    };
    transport.snapshot = {
      ...transport.snapshot,
      boxes: [{
        ...managed,
        comment: "human label",
        attributes: { presentation: 1 },
      }, manual],
      connections: [{
        targetPath: [],
        source: {
          runtimeId: managed.runtimeId,
          varName: managed.varName,
          port: 0,
        },
        destination: {
          runtimeId: manual.runtimeId,
          varName: manual.varName,
          port: 0,
        },
        attributes: { hidden: 1 },
      }],
    };

    const result = await service.inspectPatch("patch-a", "voices");

    expect(result.managedChangeCount).toBe(2);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "box_changed",
        managed: true,
        fields: ["comment", "attributes"],
      }),
      expect.objectContaining({
        kind: "connection_added",
        managed: true,
        connection: expect.objectContaining({ attributes: { hidden: 1 } }),
      }),
    ]));
  });

  it("reviews human edits as intent evidence without claiming semantic certainty", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });
    const managed = transport.snapshot.boxes[0];
    const manual = {
      targetPath: [],
      runtimeId: "manual-meter",
      varName: "manual_meter",
      maxclass: "meter~",
      patchingRect: [220, 80, 12, 80] as const,
      managed: false,
      attributes: {},
    };
    transport.snapshot = {
      ...transport.snapshot,
      boxes: [{
        ...managed,
        text: "cycle~ 880",
        patchingRect: [120, 80, 80, 22],
      }, manual],
      connections: [{
        targetPath: [],
        source: {
          runtimeId: managed.runtimeId,
          varName: managed.varName,
          port: 0,
        },
        destination: {
          runtimeId: manual.runtimeId,
          varName: manual.varName,
          port: 0,
        },
        attributes: {},
      }],
    };

    const result = await service.reviewLiveChanges("patch-a", "voices");

    expect(result).toMatchObject({
      comparisonAvailable: true,
      managedChangeCount: 2,
      unmanagedChangeCount: 1,
      canAdopt: true,
      conflicts: [],
      review: {
        affectedManagedIds: ["obj-osc"],
        affectedUnmanagedRuntimeIds: ["manual-meter"],
        signals: expect.arrayContaining([
          expect.objectContaining({ kind: "layout", objectIds: ["obj-osc"] }),
          expect.objectContaining({
            kind: "object_configuration",
            objectIds: ["obj-osc"],
          }),
          expect.objectContaining({
            kind: "object_addition",
            managed: false,
            objectIds: ["manual-meter"],
          }),
          expect.objectContaining({ kind: "routing" }),
        ]),
        editClusters: [expect.objectContaining({
          id: "edit-1",
          changeIndexes: [0, 1, 2],
          managedObjectIds: ["obj-osc"],
          unmanagedRuntimeIds: ["manual-meter"],
          observedRuntimeIds: ["manual-meter", "obj-1"],
          interpretationRisks: [
            "mixed_effects",
            "touches_unmanaged_state",
          ],
        })],
        interpretationGuidance: {
          mode: "evidence_only",
          clarificationRecommendedFor: ["edit-1"],
          instruction: expect.stringContaining("conversation context"),
        },
      },
    });
    expect(result.observedManagedRevision).not.toBe(result.acknowledgedRevision);
  });

  it("adopts reviewed managed edits and uses them as the next agent baseline", async () => {
    const transport = new FakeTransport();
    const store = new MemoryStateStore();
    const service = createService(transport, store);
    const initial = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        text: "cycle~ 880",
        patchingRect: [120, 80, 80, 22],
      })),
    };
    const review = await service.reviewLiveChanges("patch-a", "voices");

    const adopted = await service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: review.structureToken,
    });

    expect(adopted).toMatchObject({
      previousRevision: initial.plan.targetRevision,
      adoptedRevision: review.observedManagedRevision,
      revisionAdvanced: true,
      acknowledgement: {
        revision: review.observedManagedRevision,
        operations: 0,
      },
      statePersisted: true,
    });
    expect(transport.plans[1]).toMatchObject({
      baseRevision: initial.plan.targetRevision,
      targetRevision: review.observedManagedRevision,
      baseStructureToken: review.structureToken,
      operations: [],
      rollbackOperations: [],
    });
    expect(store.state?.managedGraphs.get("patch-a:voices")?.revision).toBe(
      review.observedManagedRevision
    );
    expect(store.state?.intentGraphs.get("patch-a:voices")?.revision).toBe(
      review.observedManagedRevision
    );

    const next = service.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl:
        "osc = cycle~ 880 at(120, 80)\ngain = *~ 0.5 at(120, 140)",
    });
    expect(next.plan.operations).toEqual([
      expect.objectContaining({
        op: "create",
        box: expect.objectContaining({ id: "obj-gain" }),
      }),
    ]);
    const after = await service.reviewLiveChanges("patch-a", "voices");
    expect(after.changes).toEqual([]);
  });

  it("rejects adoption when the patch changed after the agent reviewed it", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });

    await expect(service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: "f".repeat(16),
    })).rejects.toThrow("changed after review");
    expect(transport.plans).toHaveLength(1);
  });

  it("reports a manually introduced reserved identity instead of adopting it", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: [...transport.snapshot.boxes, {
        targetPath: [],
        runtimeId: "manual-reserved",
        varName: "maxforge_voices_obj_intruder",
        maxclass: "button",
        patchingRect: [150, 50, 24, 24],
        managed: true,
        attributes: {},
      }],
    };

    const review = await service.reviewLiveChanges("patch-a", "voices");
    expect(review).toMatchObject({
      canAdopt: false,
      conflicts: [{ kind: "managed_box_added", id: "obj-intruder" }],
    });
    await expect(service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: review.structureToken,
    })).rejects.toThrow("was added directly in Max");
    expect(transport.plans).toHaveLength(1);
  });

  it("adopts a human rewire without replaying patch-cord mutations", async () => {
    const transport = new FakeTransport();
    const initialDsl = [
      "a = button at(50, 50)",
      "b = button at(100, 100)",
      "c = button at(150, 100)",
      "a -> b",
    ].join("\n");
    transport.snapshot = snapshotForDsl(initialDsl, "voices");
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: initialDsl,
    });
    const boxes = new Map(transport.snapshot.boxes.map((box) => [box.varName, box]));
    const a = boxes.get("maxforge_voices_obj_a")!;
    const c = boxes.get("maxforge_voices_obj_c")!;
    transport.snapshot = {
      ...transport.snapshot,
      connections: [snapshotConnection(a, c)],
    };

    const review = await service.reviewLiveChanges("patch-a", "voices");
    expect(review.review.signals).toEqual([
      expect.objectContaining({
        kind: "routing",
        objectIds: ["obj-a", "obj-b", "obj-c"],
        changeIndexes: [0, 1],
      }),
    ]);
    const adopted = await service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: review.structureToken,
    });
    expect(adopted.acknowledgement?.operations).toBe(0);
    expect(transport.plans.at(-1)?.operations).toEqual([]);
    expect(adopted.workingDsl).toContain("a -> c");
    expect(adopted.proposedWorkingDsl).toBe(adopted.workingDsl);

    const rewiredDsl = initialDsl.replace("a -> b", "a -> c");
    expect(service.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: rewiredDsl,
    }).plan.operations).toEqual([]);
  });

  it("returns lossless working DSL for an adopted human move and resize", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        patchingRect: [-12.5, 20.25, 123.5, 31] as const,
      })),
    };

    const review = await service.reviewLiveChanges("patch-a", "voices");
    expect(review.canAdopt).toBe(true);
    expect(review.proposedWorkingDsl).toContain(
      "osc = cycle~ 440 at(-12.5, 20.25, 123.5, 31)"
    );
    const adopted = await service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: review.structureToken,
    });
    expect(adopted.workingDsl).toBe(review.proposedWorkingDsl);
    expect(service.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: adopted.workingDsl,
    }).plan.operations).toEqual([]);
  });

  it("distinguishes patch-cord attribute edits from topology changes", () => {
    const baseline = patcherSnapshot();
    const connection = {
      targetPath: [],
      source: { runtimeId: "obj-1", varName: "maxforge_voices_obj_osc", port: 0 },
      destination: { runtimeId: "obj-2", varName: "manual", port: 0 },
      attributes: { hidden: 0 },
    };
    const current = {
      ...baseline,
      connections: [{ ...connection, attributes: { hidden: 1 } }],
    };

    expect(diffPatcherSnapshots(
      { ...baseline, connections: [connection] },
      current
    )).toEqual([expect.objectContaining({
      kind: "connection_changed",
      managed: true,
      fields: ["attributes"],
    })]);
  });

  it("blocks adoption of managed patch-cord metadata not represented by protocol v1", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    const dsl = "a = button\nb = button\na -> b";
    transport.snapshot = snapshotForDsl(dsl, "voices");
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: dsl,
    });
    transport.snapshot = {
      ...transport.snapshot,
      connections: transport.snapshot.connections.map((connection) => ({
        ...connection,
        attributes: { hidden: 1 },
      })),
    };

    const review = await service.reviewLiveChanges("patch-a", "voices");
    expect(review.canAdopt).toBe(false);
    expect(review.adoptionBlockedReason).toContain(
      "protocol version 1 does not represent patch-cord metadata"
    );
    expect(review.proposedWorkingDsl).toBeUndefined();
    await expect(service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: review.structureToken,
    })).rejects.toThrow("cannot be adopted");
  });

  it("blocks adoption of an added managed patch cord with metadata", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    const dsl = "a = button\nb = button";
    transport.snapshot = snapshotForDsl(dsl, "voices");
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: dsl,
    });
    const [a, b] = transport.snapshot.boxes;
    transport.snapshot = {
      ...transport.snapshot,
      connections: [{
        ...snapshotConnection(a, b),
        attributes: { hidden: 1 },
      }],
    };

    const review = await service.reviewLiveChanges("patch-a", "voices");
    expect(review.canAdopt).toBe(false);
    expect(review.adoptionBlockedReason).toContain(
      "protocol version 1 does not represent patch-cord metadata"
    );
    expect(review.proposedWorkingDsl).toBeUndefined();
    await expect(service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: review.structureToken,
    })).rejects.toThrow("cannot be adopted");
  });

  it("blocks adoption of a removed managed patch cord with metadata", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    const dsl = "a = button\nb = button\na -> b";
    const snapshot = snapshotForDsl(dsl, "voices");
    transport.snapshot = {
      ...snapshot,
      connections: snapshot.connections.map((connection) => ({
        ...connection,
        attributes: { hidden: 1 },
      })),
    };
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: dsl,
    });
    transport.snapshot = {
      ...transport.snapshot,
      connections: [],
    };

    const review = await service.reviewLiveChanges("patch-a", "voices");
    expect(review.canAdopt).toBe(false);
    expect(review.adoptionBlockedReason).toContain(
      "protocol version 1 does not represent patch-cord metadata"
    );
    expect(review.proposedWorkingDsl).toBeUndefined();
    await expect(service.adoptLiveChanges({
      patcherId: "patch-a",
      scope: "voices",
      expectedStructureToken: review.structureToken,
    })).rejects.toThrow("cannot be adopted");
  });

  it("blocks a later apply after a managed manual edit", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        text: "cycle~ 880",
      })),
    };

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 660",
    })).rejects.toThrow("has 1 managed manual change");
    expect(transport.plans).toHaveLength(1);
  });

  it("reconciles a managed live edit with an independent desired addition", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    const baseDsl = "osc = cycle~ 440 at(50, 50)";
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: baseDsl,
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        text: "cycle~ 880",
      })),
    };
    const desiredDsl =
      `${baseDsl}\ngain = *~ 0.25 at(50, 100)`;

    const preview = await service.reconcilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl,
    });

    expect(preview).toMatchObject({
      canApply: true,
      comparisonAvailable: true,
      managedChangeCount: 1,
      conflicts: [],
      plan: {
        baseRevision: transport.plans[0].targetRevision,
        baseStructureToken: "0".repeat(16),
        operations: [{ op: "create", box: { id: "obj-gain" } }],
      },
      mergedGraph: {
        patcher: {
          boxes: expect.arrayContaining([
            expect.objectContaining({ id: "obj-osc", text: "cycle~ 880" }),
          ]),
        },
      },
    });
    const applied = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl,
      manualChanges: "merge",
    });

    expect(applied.manualChangesMerged).toBe(1);
    expect(applied.workingDslRequiredAsCurrent).toBe(true);
    expect(applied.workingDsl).toContain("osc = cycle~ 880");
    expect(applied.plan.operations).toEqual([
      expect.objectContaining({
        op: "create",
        box: expect.objectContaining({ id: "obj-gain" }),
      }),
    ]);
    expect(service.getManagedRevisions()["patch-a:voices"]).toBe(
      applied.plan.targetRevision
    );
    expect(() => service.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl:
        `${desiredDsl}\nmeter = meter~ at(50, 150)`,
    })).toThrow("contains previously merged manual edits");
    expect(service.compilePlan({
      patcherId: "patch-a",
      scope: "voices",
      currentDsl: applied.workingDsl,
      desiredDsl: `${applied.workingDsl}\nmeter = meter~ at(50, 150)`,
    }).plan.operations).toEqual([
      expect.objectContaining({
        op: "create",
        box: expect.objectContaining({ id: "obj-meter" }),
      }),
    ]);

    const alignedDesiredDsl =
      `${applied.workingDsl}\nmeter = meter~ at(50, 150)`;
    transport.snapshot = snapshotForDsl(applied.workingDsl, "voices");
    transport.snapshotAfterApply = snapshotForDsl(alignedDesiredDsl, "voices");
    const aligned = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      currentDsl: applied.workingDsl,
      desiredDsl: alignedDesiredDsl,
    });
    expect(aligned.workingDslRequiredAsCurrent).toBe(false);
    expect(aligned.baselineCaptured).toBe(true);
  });

  it("recovers an exact managed live addition from complete desired DSL", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    const baseDsl = "osc = cycle~ 440 at(50, 50)";
    transport.snapshotAfterApply = snapshotForDsl(baseDsl, "voices");
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: baseDsl,
    });

    const desiredDsl =
      `${baseDsl}\nbase_r = flonum @format 6 @maximum 1 ` +
      "@minimum 0 @parameter_enable 0 at(104.5, 458, 50, 22)";
    transport.snapshot = snapshotForDsl(desiredDsl, "voices");
    transport.snapshotAfterApply = snapshotForDsl(desiredDsl, "voices");

    const preview = await service.reconcilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl,
    });

    expect(preview).toMatchObject({
      canApply: true,
      conflicts: [],
      managedChangeCount: 1,
      plan: {
        baseRevision: transport.plans[0].targetRevision,
        operations: [],
      },
    });

    const applied = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl,
      manualChanges: "merge",
      expectedStructureToken: preview.structureToken,
    });

    expect(applied.plan.operations).toEqual([]);
    expect(applied.acknowledgement.revision).toBe(
      preview.plan?.targetRevision
    );
    expect(applied.baselineCaptured).toBe(true);
    expect(applied.workingDsl).toContain("base_r = flonum");
  });

  it("ignores runtime bpatcher port metadata during lossless reconciliation", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    const baseDsl = [
      "global_speed = bpatcher @name fparam.maxpat @args speed /speed 0. 4. at(10, 10, 268, 31)",
      "global_reset = bpatcher @name bparam.maxpat @args reset /reset at(10, 50, 106, 31)",
    ].join("\n");
    transport.snapshotAfterApply = snapshotForDsl(baseDsl, "voices");
    const initial = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: baseDsl,
    });
    expect(initial.baselineCaptured).toBe(true);
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box, index) => ({
        ...box,
        attributes: {
          ...box.attributes,
          ...(box.attributes.args
            ? {
                args: box.attributes.args.map((value) =>
                  value === "0." ? "0" : value === "4." ? "4" : value
                ),
              }
            : {}),
          numinlets: index + 1,
          numoutlets: index + 2,
          outlettype: Array.from({ length: index + 2 }, () => ""),
        },
      })),
    };
    expect(transport.snapshot.boxes[0].attributes).toHaveProperty(
      "numinlets",
      1
    );
    const desiredDsl = `${baseDsl}\ntrigger_1 = button at(10, 100)`;

    const preview = await service.reconcilePlan({
      patcherId: "patch-a",
      scope: "voices",
      currentDsl: baseDsl,
      desiredDsl,
    });
    expect(preview).toMatchObject({
      canApply: true,
      conflicts: [],
      plan: {
        operations: [{ op: "create", box: { id: "obj-trigger_1" } }],
      },
    });
    expect(preview.mergedGraph?.patcher.boxes[0].attributes).not.toHaveProperty(
      "numinlets"
    );
    expect(preview.mergedGraph?.patcher.boxes[1].attributes.args).toEqual([
      "speed",
      "/speed",
      "0",
      "4",
    ]);

    const applied = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      currentDsl: baseDsl,
      desiredDsl,
      manualChanges: "merge",
    });
    expect(applied.plan.operations).toEqual([
      expect.objectContaining({
        op: "create",
        box: expect.objectContaining({ id: "obj-trigger_1" }),
      }),
    ]);
    expect(applied.workingDsl).not.toMatch(/@numinlets|@numoutlets|@outlettype/);
  });

  it("does not report canApply when the merged graph cannot serialize", async () => {
    const transport = new FakeTransport();
    const adapter = new DslPatchAdapter(database);
    const service = new MaxforgePatchService(adapter, transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });
    adapter.serialize = () => {
      throw new Error("synthetic lossless round-trip failure");
    };

    const preview = await service.reconcilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440\ngain = *~ 0.5",
    });

    expect(preview).toMatchObject({
      canApply: false,
      plan: undefined,
      conflicts: [{
        kind: "unrepresentable_graph",
        targetPath: [],
        message: "synthetic lossless round-trip failure",
      }],
    });
  });

  it("rejects merge when live and desired DSL change the same field", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        text: "cycle~ 660",
      })),
    };

    const preview = await service.reconcilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 880 at(50, 50)",
    });
    expect(preview).toMatchObject({
      canApply: false,
      conflicts: [{ kind: "box_field", id: "obj-osc", field: "text" }],
    });

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 880 at(50, 50)",
      manualChanges: "merge",
    })).rejects.toThrow("changed differently");
    expect(transport.plans).toHaveLength(1);
  });

  it("recomputes port metadata when a live object text changes", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    const currentDsl = "osc = cycle~ 440 at(50, 50)";
    await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: currentDsl,
    });
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        text: "trigger b i f",
      })),
    };

    const preview = await service.reconcilePlan({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: `${currentDsl}\ngain = *~ 0.25 at(50, 100)`,
    });

    expect(preview).toMatchObject({
      canApply: true,
      mergedGraph: {
        patcher: {
          boxes: expect.arrayContaining([
            expect.objectContaining({
              id: "obj-osc",
              text: "trigger b i f",
              numinlets: 1,
              numoutlets: 3,
              outlettype: ["bang", "int", "float"],
            }),
          ]),
        },
      },
    });
  });

  it("can reconcile after restart when exact current DSL seeds the base graph", async () => {
    const transport = new FakeTransport();
    const currentDsl = "osc = cycle~ 440 at(50, 50)";
    const current = compileDslToPatchGraph(currentDsl, database, "voices").graph!;
    transport.liveRevisions.set("patch-a:voices", current.revision);
    transport.snapshot = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        text: "cycle~ 880",
      })),
    };
    const service = createService(transport);

    const preview = await service.reconcilePlan({
      patcherId: "patch-a",
      scope: "voices",
      currentDsl,
      desiredDsl: `${currentDsl}\ngain = *~ 0.25 at(50, 100)`,
    });

    expect(preview).toMatchObject({
      canApply: true,
      comparisonAvailable: false,
      managedChangeCount: 2,
      conflicts: [],
      plan: {
        baseRevision: current.revision,
        operations: [{ op: "create", box: { id: "obj-gain" } }],
      },
    });
  });

  it("does not misreport an acknowledged apply as failed when baseline capture fails", async () => {
    const transport = new FakeTransport();
    const service = createService(transport);
    transport.postApplyInspectionFailure = new Error("snapshot timeout");

    const result = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });

    expect(result.baselineCaptured).toBe(false);
    expect(result.baselineWarning).toContain(
      "Max applied the patch"
    );
    expect(service.getManagedRevisions()).toEqual({
      "patch-a:voices": result.plan.targetRevision,
    });
  });

  it("does not capture a post-apply baseline that differs from the target graph", async () => {
    const transport = new FakeTransport();
    transport.snapshotAfterApply = {
      ...transport.snapshot,
      boxes: transport.snapshot.boxes.map((box) => ({
        ...box,
        text: "cycle~ 880",
      })),
    };
    const service = createService(transport);

    const result = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)",
    });

    expect(result.baselineCaptured).toBe(false);
    expect(result.baselineWarning).toContain(
      "post-apply snapshot does not match"
    );
    expect(service.getBaselineScopes()).toEqual([]);
    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440 at(50, 50)\ngain = *~ 0.5",
    })).rejects.toThrow("managed manual change");
    expect(transport.plans).toHaveLength(1);
  });
});

function retainedObservation(
  sequence: number,
  sessionSequence: number,
  sessionId: string,
  baseline: MaxforgePatcherSnapshot,
  patcher: MaxforgePatcherSnapshot
): MaxforgeEditObservationHistory["observations"][number] {
  return {
    sequence,
    sessionSequence,
    sessionId,
    instanceId: `instance-${sessionId}`,
    sessionStartedAt: "2026-08-11T00:00:00.000Z",
    sessionBaseline: {
      structureToken: "0".repeat(16),
      patcher: baseline,
    },
    observedAt: "2026-08-11T00:00:01.000Z",
    event: {
      type: "maxforge.edit.observed",
      patcherId: "patch-a",
      scope: "voices",
      revision: null,
      structureToken: "1".repeat(16),
      causes: ["box"],
      patcher,
    },
  };
}

function disabledHistoryPersistence() {
  return {
    enabled: false,
    projectId: null,
    location: null,
    warnings: [],
  } as const;
}

class FakeTransport implements PatchPlanTransport {
  readonly plans: PatchPlan[] = [];
  readonly liveRevisions = new Map<string, string | null>();
  failure: Error | undefined;
  failureAfterApply: Error | undefined;
  inspectionFailure: Error | undefined;
  postApplyInspectionFailure: Error | undefined;
  snapshotAfterApply: MaxforgePatcherSnapshot | undefined;
  snapshot: MaxforgePatcherSnapshot = patcherSnapshot();
  inspectionCount = 0;
  patches: readonly MaxforgePatchInfo[] = [];
  connectedClients = 1;
  retainedHistoryCount = 0;
  editHistory: MaxforgeEditObservationHistory = {
    supported: true,
    droppedEvents: 0,
    persistence: disabledHistoryPersistence(),
    identity: null,
    patchMetadata: [],
    observations: [],
  };

  async apply(
    patcherId: string,
    plan: PatchPlan
  ): Promise<MaxforgeAppliedEvent> {
    this.plans.push(plan);
    if (this.failure) throw this.failure;
    this.liveRevisions.set(
      `${patcherId}:${plan.scope}`,
      plan.targetRevision
    );
    if (this.failureAfterApply) throw this.failureAfterApply;
    if (this.snapshotAfterApply) this.snapshot = this.snapshotAfterApply;
    return {
      type: "maxforge.applied",
      requestId: "fake-apply",
      patcherId,
      scope: plan.scope,
      revision: plan.targetRevision,
      operations: plan.operations.length,
    };
  }

  async inspect(
    patcherId: string,
    scope: string
  ): Promise<MaxforgeSnapshotEvent> {
    this.inspectionCount++;
    if (this.inspectionFailure) throw this.inspectionFailure;
    if (
      this.postApplyInspectionFailure &&
      this.liveRevisions.has(`${patcherId}:${scope}`)
    ) {
      throw this.postApplyInspectionFailure;
    }
    return {
      type: "maxforge.snapshot",
      requestId: "fake-request",
      patcherId,
      scope,
      revision: this.liveRevisions.get(`${patcherId}:${scope}`) ?? null,
      structureToken: "0".repeat(16),
      patcher: this.snapshot,
    };
  }

  getEditObservationHistory(): MaxforgeEditObservationHistory {
    return this.editHistory;
  }

  clearEditObservationHistory(): number {
    const cleared = this.retainedHistoryCount;
    this.retainedHistoryCount = 0;
    return cleared;
  }

  async createPatch(
    request: CreateMaxPatchRequest
  ): Promise<MaxforgePatchInfo> {
    return {
      ...request,
      instanceId: "fake-instance",
      sessionId: "fake-session",
      revision: null,
      controller: false,
      filename: "",
      filepath: "",
      externalVersion: "0.4.0",
      versionCompatible: true,
      capabilities: ["edit_observation_v1"],
    };
  }

  async openPatch(request: OpenMaxPatchRequest): Promise<MaxforgePatchInfo> {
    return {
      ...request,
      instanceId: "fake-instance",
      sessionId: "fake-session",
      revision: null,
      controller: false,
      filename: "opened.maxpat",
      filepath: request.path,
      externalVersion: "0.4.0",
      versionCompatible: true,
      capabilities: ["edit_observation_v1"],
    };
  }

  async savePatch(
    request: SaveMaxPatchRequest
  ): Promise<MaxforgePatchSavedEvent> {
    return {
      type: "maxforge.patch.saved",
      requestId: "fake-save",
      patcherId: request.patcherId,
      scope: request.scope,
      filename: "saved.maxpat",
      filepath: request.path ?? "/tmp/saved.maxpat",
      dirty: false,
    };
  }

  async closePatch(
    request: CloseMaxPatchRequest
  ): Promise<MaxforgePatchClosingEvent> {
    return {
      type: "maxforge.patch.closing",
      requestId: "fake-close",
      patcherId: request.patcherId,
      scope: request.scope,
      discarded: request.discard ?? false,
    };
  }

  listPatches(): readonly MaxforgePatchInfo[] {
    return this.patches;
  }

  getLiveRevision(
    patcherId: string,
    scope: string
  ): string | null | undefined {
    return this.liveRevisions.get(`${patcherId}:${scope}`);
  }

  getStatus(): MaxforgeBridgeStatus {
    return {
      host: "127.0.0.1",
      port: 8766,
      expectedExternalVersion: "0.4.0",
      connectedClients: this.connectedClients,
      registeredPatches: [],
      liveRevisions: Object.fromEntries(this.liveRevisions),
      editHistoryPersistence: disabledHistoryPersistence(),
    };
  }
}

class MemoryStateStore implements PatchStateStore {
  readonly description = "memory";
  state: PatchServiceState | undefined;

  load(): PatchServiceState | undefined {
    if (!this.state) return undefined;
    return cloneServiceState(this.state);
  }

  save(state: PatchServiceState): void {
    this.state = cloneServiceState(state);
  }
}

function cloneServiceState(state: PatchServiceState): PatchServiceState {
  return {
    managedGraphs: new Map(state.managedGraphs),
    intentGraphs: new Map(state.intentGraphs),
    workingSources: new Map(state.workingSources),
    intentSources: new Map(state.intentSources),
    baselineSnapshots: new Map(state.baselineSnapshots),
    pendingApplies: new Map(state.pendingApplies),
  };
}

function patcherSnapshot(): MaxforgePatcherSnapshot {
  return {
    title: "service test",
    filename: "service.maxpat",
    filepath: "/tmp/service.maxpat",
    dirty: true,
    locked: false,
    presentation: false,
    boxes: [{
      targetPath: [],
      runtimeId: "obj-1",
      varName: "maxforge_voices_obj_osc",
      maxclass: "cycle~",
      patchingRect: [50, 50, 80, 22],
      managed: true,
      text: "cycle~ 440",
      attributes: {},
    }],
    connections: [],
  };
}

function snapshotForDsl(dsl: string, scope: string): MaxforgePatcherSnapshot {
  const graph = compileDslToPatchGraph(dsl, database, scope).graph!;
  return snapshotForGraph(graph);
}

function snapshotForGraph(graph: PatchGraph): MaxforgePatcherSnapshot {
  const boxes = graph.patcher.boxes.map((box) => ({
    targetPath: [],
    runtimeId: `runtime-${box.id}`,
    varName: box.varName,
    maxclass: box.maxclass,
    patchingRect: box.patchingRect,
    managed: true,
    ...(box.text !== undefined ? { text: box.text } : {}),
    ...(box.comment !== undefined ? { comment: box.comment } : {}),
    attributes: Object.fromEntries(
      Object.entries(box.attributes).filter(
        (entry): entry is [string, PatchSetValue] => isSnapshotValue(entry[1])
      )
    ),
  }));
  const boxesById = new Map(
    graph.patcher.boxes.map((box, index) => [box.id, boxes[index]])
  );
  return {
    title: "service test",
    filename: "service.maxpat",
    filepath: "/tmp/service.maxpat",
    dirty: true,
    locked: false,
    presentation: false,
    boxes,
    connections: graph.patcher.connections.map((connection) =>
      snapshotConnection(
        boxesById.get(connection.source.id)!,
        boxesById.get(connection.destination.id)!,
        connection.source.port,
        connection.destination.port
      )
    ),
  };
}

function snapshotConnection(
  source: MaxforgePatcherSnapshot["boxes"][number],
  destination: MaxforgePatcherSnapshot["boxes"][number],
  sourcePort = 0,
  destinationPort = 0
): MaxforgePatcherSnapshot["connections"][number] {
  return {
    targetPath: [],
    source: {
      runtimeId: source.runtimeId,
      varName: source.varName,
      port: sourcePort,
    },
    destination: {
      runtimeId: destination.runtimeId,
      varName: destination.varName,
      port: destinationPort,
    },
    attributes: {},
  };
}

function isSnapshotValue(value: unknown): value is PatchSetValue {
  return typeof value === "string" || typeof value === "number" ||
    (Array.isArray(value) && value.every((item) =>
      typeof item === "string" || typeof item === "number"
    ));
}
