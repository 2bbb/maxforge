import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  MaxforgeAppliedEvent,
  MaxforgeBridgeStatus,
  MaxforgePatcherSnapshot,
  MaxforgeSnapshotEvent,
  PatchPlanTransport,
} from "../src/mcp/bridge.js";
import { MaxforgePatchService } from "../src/mcp/service.js";
import { PatchPlan } from "../src/max/patch-graph.js";

const database = dbData as ObjectDatabase;

describe("MaxforgePatchService", () => {
  it("advances remembered desired state only after Max acknowledges an apply", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);

    const first = await service.applyDsl({
      scope: "voices",
      desiredDsl: "osc_0 = cycle~ 440",
    });
    const second = await service.applyDsl({
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
      voices: second.plan.targetRevision,
    });
  });

  it("compiles read-only plans against the same remembered state used by apply", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
    await service.applyDsl({
      scope: "voices",
      desiredDsl: "osc_0 = cycle~ 440",
    });

    const preview = service.compilePlan({
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
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    })).rejects.toThrow("rejected");

    expect(service.getManagedRevisions()).toEqual({});
  });

  it("requires current DSL after MCP restarts against initialized Max state", async () => {
    const transport = new FakeTransport();
    transport.liveRevisions.set("voices", "a".repeat(64));
    const service = new MaxforgePatchService(database, transport);

    await expect(service.applyDsl({
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    })).rejects.toThrow("this MCP process has no graph state");
    expect(transport.plans).toHaveLength(0);
  });

  it("rejects caller-provided current DSL when its revision differs from Max", async () => {
    const transport = new FakeTransport();
    transport.liveRevisions.set("voices", "b".repeat(64));
    const service = new MaxforgePatchService(database, transport);

    await expect(service.applyDsl({
      scope: "voices",
      currentDsl: "osc = cycle~ 440",
      desiredDsl: "osc = cycle~ 880",
    })).rejects.toThrow("does not match Max scope");
    expect(transport.plans).toHaveLength(0);
  });

  it("reports DSL diagnostics without sending an invalid plan", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);

    await expect(service.applyDsl({
      scope: "voices",
      desiredDsl: "osc = object_that_does_not_exist",
    })).rejects.toThrow("[E003]");
    expect(transport.plans).toHaveLength(0);
  });

  it("reports exact structural changes without reading the screen", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
    await service.applyDsl({
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

    const result = await service.inspectPatch("voices");

    expect(result).toMatchObject({
      comparisonAvailable: true,
      managedChangeCount: 1,
      unmanagedChangeCount: 0,
      changes: [{
        kind: "box_changed",
        managed: true,
        fields: ["patchingRect"],
        before: { patchingRect: [10, 20, 66, 22] },
        after: { patchingRect: [120, 80, 66, 22] },
      }],
    });
  });

  it("blocks a later apply after a managed manual edit", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
    await service.applyDsl({
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
      scope: "voices",
      desiredDsl: "osc = cycle~ 660",
    })).rejects.toThrow("has 1 managed manual change");
    expect(transport.plans).toHaveLength(1);
  });

  it("does not misreport an acknowledged apply as failed when baseline capture fails", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
    transport.inspectionFailure = new Error("snapshot timeout");

    const result = await service.applyDsl({
      scope: "voices",
      desiredDsl: "osc = cycle~ 440",
    });

    expect(result.baselineCaptured).toBe(false);
    expect(result.baselineWarning).toContain(
      "Max applied the patch"
    );
    expect(service.getManagedRevisions()).toEqual({
      voices: result.plan.targetRevision,
    });
  });
});

class FakeTransport implements PatchPlanTransport {
  readonly plans: PatchPlan[] = [];
  readonly liveRevisions = new Map<string, string | null>();
  failure: Error | undefined;
  inspectionFailure: Error | undefined;
  snapshot: MaxforgePatcherSnapshot = patcherSnapshot();

  async apply(plan: PatchPlan): Promise<MaxforgeAppliedEvent> {
    this.plans.push(plan);
    if (this.failure) throw this.failure;
    this.liveRevisions.set(plan.scope, plan.targetRevision);
    return {
      type: "maxforge.applied",
      scope: plan.scope,
      revision: plan.targetRevision,
      operations: plan.operations.length,
    };
  }

  async inspect(scope: string): Promise<MaxforgeSnapshotEvent> {
    if (this.inspectionFailure) throw this.inspectionFailure;
    return {
      type: "maxforge.snapshot",
      requestId: "fake-request",
      scope,
      revision: this.liveRevisions.get(scope) ?? null,
      patcher: this.snapshot,
    };
  }

  getLiveRevision(scope: string): string | null | undefined {
    return this.liveRevisions.get(scope);
  }

  getStatus(): MaxforgeBridgeStatus {
    return {
      host: "127.0.0.1",
      port: 8766,
      connectedClients: 1,
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
      patchingRect: [10, 20, 66, 22],
      managed: true,
      text: "cycle~ 440",
    }],
    connections: [],
  };
}
