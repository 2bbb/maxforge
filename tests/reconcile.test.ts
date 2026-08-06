import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  compileDslToPatchGraph,
  PatchGraph,
} from "../src/max/patch-graph.js";
import { MaxforgePatcherSnapshot } from "../src/mcp/bridge.js";
import { reconcilePatchGraphs } from "../src/mcp/reconcile.js";

const database = dbData as ObjectDatabase;

describe("live patch reconciliation", () => {
  it("builds live-to-merged operations while retaining the native base revision", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\ngain = *~ 0.25 at(10, 80)"
    );
    const current = snapshot(base, {
      "obj-osc": { text: "cycle~ 880" },
    });

    const result = reconcilePatchGraphs(base, desired, current, snapshot(base));

    expect(result.conflicts).toEqual([]);
    expect(result.plan).toMatchObject({
      baseRevision: base.revision,
      operations: [{ op: "create", box: { id: "obj-gain" } }],
    });
    expect(result.graph?.patcher.boxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "obj-osc", text: "cycle~ 880" }),
      ])
    );
    expect(result.plan?.targetRevision).toBe(result.graph?.revision);
  });

  it("combines a live position with a desired text replacement", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph("osc = cycle~ 880 at(10, 20)");
    const current = snapshot(base, {
      "obj-osc": { patchingRect: [80, 90, 80, 22] },
    });

    const result = reconcilePatchGraphs(base, desired, current, snapshot(base));

    expect(result.conflicts).toEqual([]);
    expect(result.plan?.operations.map((operation) => operation.op)).toEqual([
      "delete",
      "create",
    ]);
    expect(result.plan?.operations[1]).toMatchObject({
      op: "create",
      box: { text: "cycle~ 880", patchingRect: [80, 90, 80, 22] },
    });
  });

  it("returns a structured conflict for divergent live and desired text", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph("osc = cycle~ 880 at(10, 20)");
    const current = snapshot(base, {
      "obj-osc": { text: "cycle~ 660" },
    });

    const result = reconcilePatchGraphs(base, desired, current, snapshot(base));

    expect(result.plan).toBeUndefined();
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "box_field",
        id: "obj-osc",
        field: "text",
      }),
    ]);
  });

  it("preserves a live deletion while applying an independent desired addition", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\ngain = *~ 0.25 at(10, 80)"
    );
    const current = { ...snapshot(base), boxes: [] };

    const result = reconcilePatchGraphs(base, desired, current, snapshot(base));

    expect(result.conflicts).toEqual([]);
    expect(result.graph?.patcher.boxes.map((box) => box.id)).toEqual([
      "obj-gain",
    ]);
    expect(result.plan?.operations).toEqual([
      expect.objectContaining({ op: "create", box: expect.objectContaining({ id: "obj-gain" }) }),
    ]);
  });

  it("blocks replacement that would destroy a cord to an unmanaged box", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph("osc = cycle~ 880 at(10, 20)");
    const current = snapshot(base);
    current.boxes.push({
      targetPath: [],
      runtimeId: "runtime-manual",
      varName: "manual_button",
      maxclass: "button",
      patchingRect: [180, 20, 24, 24],
      managed: false,
    });
    current.connections.push({
      targetPath: [],
      source: {
        runtimeId: "runtime-osc",
        varName: "maxforge_voices_obj_osc",
        port: 0,
      },
      destination: {
        runtimeId: "runtime-manual",
        varName: "manual_button",
        port: 0,
      },
    });

    const result = reconcilePatchGraphs(base, desired, current, snapshot(base));

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "external_connection_at_risk",
        id: "obj-osc",
      }),
    ]);
  });

  it("rejects a directly added reserved managed identity", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const current = snapshot(base);
    current.boxes.push({
      targetPath: [],
      runtimeId: "runtime-extra",
      varName: "maxforge_voices_obj_extra",
      maxclass: "newobj",
      patchingRect: [180, 20, 80, 22],
      managed: true,
      text: "cycle~ 220",
    });

    const result = reconcilePatchGraphs(base, base, current, snapshot(base));

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "managed_box_added",
        id: "obj-extra",
      }),
    ]);
  });
});

function graph(source: string): PatchGraph {
  const result = compileDslToPatchGraph(source, database, "voices");
  expect(result.errors).toEqual([]);
  return result.graph!;
}

function snapshot(
  graph: PatchGraph,
  overrides: Readonly<Record<
    string,
    { readonly text?: string; readonly patchingRect?: [number, number, number, number] }
  >> = {}
): MaxforgePatcherSnapshot & {
  boxes: Array<MaxforgePatcherSnapshot["boxes"][number]>;
  connections: Array<MaxforgePatcherSnapshot["connections"][number]>;
} {
  const boxes = graph.patcher.boxes.map((box) => {
    const override = overrides[box.id];
    return {
      targetPath: [],
      runtimeId: `runtime-${box.id.substring(4)}`,
      varName: box.varName,
      maxclass: box.maxclass,
      patchingRect: override?.patchingRect ?? [...box.patchingRect] as [number, number, number, number],
      managed: true,
      ...(override?.text !== undefined
        ? { text: override.text }
        : box.text !== undefined
          ? { text: box.text }
          : {}),
    };
  });
  const runtimeById = new Map(
    graph.patcher.boxes.map((box) => [box.id, `runtime-${box.id.substring(4)}`])
  );
  const connections = graph.patcher.connections.map((connection) => ({
    targetPath: [],
    source: {
      runtimeId: runtimeById.get(connection.source.id)!,
      varName: connection.source.varName,
      port: connection.source.port,
    },
    destination: {
      runtimeId: runtimeById.get(connection.destination.id)!,
      varName: connection.destination.varName,
      port: connection.destination.port,
    },
  }));
  return {
    title: "Reconcile test",
    filename: "reconcile.maxpat",
    filepath: "/tmp/reconcile.maxpat",
    dirty: true,
    locked: false,
    presentation: false,
    boxes,
    connections,
  };
}
