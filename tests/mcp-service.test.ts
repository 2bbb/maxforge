import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  MaxforgeAppliedEvent,
  MaxforgeBridgeStatus,
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
});

class FakeTransport implements PatchPlanTransport {
  readonly plans: PatchPlan[] = [];
  readonly liveRevisions = new Map<string, string | null>();
  failure: Error | undefined;

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
