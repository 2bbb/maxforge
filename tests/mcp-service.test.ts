import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  CreateMaxPatchRequest,
  MaxforgeAppliedEvent,
  MaxforgeBridgeStatus,
  MaxforgePatchInfo,
  MaxforgePatcherSnapshot,
  MaxforgeSnapshotEvent,
  PatchPlanTransport,
} from "../src/mcp/bridge.js";
import { MaxforgePatchService } from "../src/mcp/service.js";
import {
  compileDslToPatchGraph,
  PatchPlan,
} from "../src/max/patch-graph.js";

const database = dbData as ObjectDatabase;

describe("MaxforgePatchService", () => {
  it("advances remembered desired state only after Max acknowledges an apply", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);

    const first = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc_0 = cycle~ 440",
    });
    const second = await service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc_0 = cycle~ 440\nosc_1 = cycle~ 660",
    });

    expect(first.plan.operations.map((operation) => operation.op)).toEqual([
      "create",
    ]);
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
  });

  it("compiles read-only plans against the same remembered state used by apply", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
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
    const service = new MaxforgePatchService(database, transport);
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
    const service = new MaxforgePatchService(database, transport);

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    })).rejects.toThrow("this MCP process has no graph state");
    expect(transport.plans).toHaveLength(0);
  });

  it("rejects caller-provided current DSL when its revision differs from Max", async () => {
    const transport = new FakeTransport();
    transport.liveRevisions.set("patch-a:voices", "b".repeat(64));
    const service = new MaxforgePatchService(database, transport);

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
    const service = new MaxforgePatchService(database, transport);

    await expect(service.applyDsl({
      patcherId: "patch-a",
      scope: "voices",
      desiredDsl: "osc = object_that_does_not_exist",
    })).rejects.toThrow("[E003]");
    expect(transport.plans).toHaveLength(0);
  });

  it("reports exact structural changes without reading the screen", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
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

  it("blocks a later apply after a managed manual edit", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
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
    const service = new MaxforgePatchService(database, transport);
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
  });

  it("rejects merge when live and desired DSL change the same field", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
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
    const service = new MaxforgePatchService(database, transport);
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
    const service = new MaxforgePatchService(database, transport);

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
    const service = new MaxforgePatchService(database, transport);
    transport.inspectionFailure = new Error("snapshot timeout");

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
    const service = new MaxforgePatchService(database, transport);

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
  });
});

class FakeTransport implements PatchPlanTransport {
  readonly plans: PatchPlan[] = [];
  readonly liveRevisions = new Map<string, string | null>();
  failure: Error | undefined;
  inspectionFailure: Error | undefined;
  snapshotAfterApply: MaxforgePatcherSnapshot | undefined;
  snapshot: MaxforgePatcherSnapshot = patcherSnapshot();

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
    if (this.inspectionFailure) throw this.inspectionFailure;
    return {
      type: "maxforge.snapshot",
      requestId: "fake-request",
      patcherId,
      scope,
      revision: this.liveRevisions.get(`${patcherId}:${scope}`) ?? null,
      patcher: this.snapshot,
    };
  }

  async createPatch(
    request: CreateMaxPatchRequest
  ): Promise<MaxforgePatchInfo> {
    return {
      ...request,
      revision: null,
      controller: false,
      filename: "",
      filepath: "",
    };
  }

  listPatches(): readonly MaxforgePatchInfo[] {
    return [];
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
      connectedClients: 1,
      registeredPatches: [],
      liveRevisions: Object.fromEntries(this.liveRevisions),
    };
  }
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
    }],
    connections: [],
  };
}
