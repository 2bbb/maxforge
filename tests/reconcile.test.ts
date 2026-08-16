import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  PatchGraph,
  PatchSetValue,
} from "../src/max/patch-graph.js";
import { compileDslToPatchGraph } from "../src/max/dsl-patch-graph.js";
import { MaxforgePatcherSnapshot } from "../src/max/patch-protocol.js";
import { reconcilePatchGraphs } from "../src/mcp/reconcile.js";

const database = dbData as unknown as ObjectDatabase;

describe("live patch reconciliation", () => {
  it("builds live-to-merged operations while retaining the native base revision", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\ngain = *~ 0.25 at(10, 80)"
    );
    const current = snapshot(base, {
      "obj-osc": { text: "cycle~ 880" },
    });

    const result = reconcilePatchGraphs(base, base, desired, current, snapshot(base));

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

    const result = reconcilePatchGraphs(base, base, desired, current, snapshot(base));

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

    const result = reconcilePatchGraphs(base, base, desired, current, snapshot(base));

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

    const result = reconcilePatchGraphs(base, base, desired, current, snapshot(base));

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
      attributes: {},
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
      attributes: {},
    });

    const result = reconcilePatchGraphs(base, base, desired, current, snapshot(base));

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
      attributes: {},
    });

    const result = reconcilePatchGraphs(base, base, base, current, snapshot(base));

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "managed_box_added",
        id: "obj-extra",
      }),
    ]);
  });

  it("recovers an exact live managed addition declared in complete desired DSL", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\nextra = cycle~ 220 at(180, 20)"
    );

    const result = reconcilePatchGraphs(
      base,
      base,
      desired,
      snapshot(desired),
      snapshot(base)
    );

    expect(result.conflicts).toEqual([]);
    expect(result.graph?.revision).toBe(desired.revision);
    expect(result.plan).toMatchObject({
      baseRevision: base.revision,
      targetRevision: desired.revision,
      operations: [],
    });
  });

  it.each(["number", "flonum"])(
    "ignores runtime display text when recovering a directly added %s box",
    (maxclass) => {
      const base = graph("osc = cycle~ 440 at(10, 20)");
      const desired = graph(
        `osc = cycle~ 440 at(10, 20)\n` +
        `extra = ${maxclass} @minimum 0 @maximum 1 at(180, 20, 50, 22)`
      );
      const current = snapshot(desired);
      const extraIndex = current.boxes.findIndex(
        (box) => box.varName === "maxforge_voices_obj_extra"
      );
      current.boxes[extraIndex] = {
        ...current.boxes[extraIndex],
        text: "0.",
      };

      const result = reconcilePatchGraphs(
        base,
        base,
        desired,
        current,
        snapshot(base)
      );

      expect(result.conflicts).toEqual([]);
      expect(result.graph?.revision).toBe(desired.revision);
      expect(
        result.graph?.patcher.boxes.find((box) => box.id === "obj-extra")?.text
      ).toBeUndefined();
      expect(result.plan).toMatchObject({
        baseRevision: base.revision,
        targetRevision: desired.revision,
        operations: [],
      });
    }
  );

  it("rejects a recovered managed addition whose live box differs from desired DSL", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\nextra = cycle~ 220 at(180, 20)"
    );
    const live = graph(
      "osc = cycle~ 440 at(10, 20)\nextra = cycle~ 330 at(180, 20)"
    );

    const result = reconcilePatchGraphs(
      base,
      base,
      desired,
      snapshot(live),
      snapshot(base)
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "box_concurrent_add",
        id: "obj-extra",
      }),
    ]);
  });

  it("rejects recovered managed additions with non-matching live connections", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\nextra = *~ 0.5 at(180, 20)"
    );
    const live = graph(
      "osc = cycle~ 440 at(10, 20)\nextra = *~ 0.5 at(180, 20)\n" +
      "osc -> extra"
    );

    const result = reconcilePatchGraphs(
      base,
      base,
      desired,
      snapshot(live),
      snapshot(base)
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "box_concurrent_add",
        id: "obj-extra",
        message: expect.stringContaining("do not exactly match"),
      }),
    ]);
  });

  it("rejects recovered managed additions connected to unmanaged live boxes", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\nextra = *~ 0.5 at(180, 20)"
    );
    const current = snapshot(desired);
    current.boxes.push({
      targetPath: [],
      runtimeId: "runtime-manual",
      varName: "manual_meter",
      maxclass: "meter~",
      patchingRect: [300, 20, 80, 22],
      managed: false,
      attributes: {},
    });
    current.connections.push({
      targetPath: [],
      source: {
        runtimeId: "runtime-extra",
        varName: "maxforge_voices_obj_extra",
        port: 0,
      },
      destination: {
        runtimeId: "runtime-manual",
        varName: "manual_meter",
        port: 0,
      },
      attributes: {},
    });

    const result = reconcilePatchGraphs(
      base,
      base,
      desired,
      current,
      snapshot(base)
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "external_connection_at_risk",
        id: "obj-extra",
      }),
    ]);
  });

  it("rejects patch-cord metadata on recovered managed additions", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\nextra = *~ 0.5 at(180, 20)\n" +
      "osc -> extra"
    );
    const current = snapshot(desired);
    current.connections[0] = {
      ...current.connections[0],
      attributes: { hidden: 1 },
    };

    const result = reconcilePatchGraphs(
      base,
      base,
      desired,
      current,
      snapshot(base)
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "unrepresentable_graph",
        message: expect.stringContaining("protocol version 1"),
      }),
    ]);
  });

  it("preserves an earlier merged human edit across later agent changes", () => {
    const intent = graph(
      "osc = cycle~ 440 at(10, 20)\ngain = *~ 0.25 at(10, 80)"
    );
    const acknowledged = graph(
      "osc = cycle~ 880 at(10, 20)\ngain = *~ 0.25 at(10, 80)"
    );
    const desired = graph(
      "osc = cycle~ 440 at(10, 20)\ngain = *~ 0.25 at(10, 80)\n" +
      "meter = meter~ at(10, 140)"
    );

    const result = reconcilePatchGraphs(
      acknowledged,
      intent,
      desired,
      snapshot(acknowledged),
      snapshot(acknowledged)
    );

    expect(result.conflicts).toEqual([]);
    expect(result.plan).toMatchObject({
      baseRevision: acknowledged.revision,
      operations: [{ op: "create", box: { id: "obj-meter" } }],
    });
    expect(result.graph?.patcher.boxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "obj-osc", text: "cycle~ 880" }),
      ])
    );
  });

  it("scopes repeated runtime IDs to their containing patcher", () => {
    const base = graph(`
fx = p pass at(10, 20) {
  input = inlet signal at(10, 20)
  output = outlet signal at(10, 80)
  input -> output
}
`);
    const desired = graph(`
fx = p pass at(10, 20) {
  input = inlet signal at(10, 20)
  output = outlet signal at(10, 80)
  input -> output
}
button_0 = button at(160, 20)
`);
    const fx = base.patcher.boxes[0];
    const input = fx.patcher!.boxes[0];
    const output = fx.patcher!.boxes[1];
    const nestedPath = [fx.varName];
    const current: MaxforgePatcherSnapshot = {
      title: "Nested",
      filename: "nested.maxpat",
      filepath: "/tmp/nested.maxpat",
      dirty: true,
      locked: false,
      presentation: false,
      boxes: [
        snapshotBox(fx, [], "obj-1"),
        snapshotBox(input, nestedPath, "obj-1"),
        snapshotBox(output, nestedPath, "obj-2"),
      ],
      connections: [{
        targetPath: nestedPath,
        source: {
          runtimeId: "obj-1",
          varName: input.varName,
          port: 0,
        },
        destination: {
          runtimeId: "obj-2",
          varName: output.varName,
          port: 0,
        },
        attributes: {},
      }],
    };

    const result = reconcilePatchGraphs(base, base, desired, current, current);

    expect(result.conflicts).toEqual([]);
    expect(result.plan?.operations).toEqual([
      expect.objectContaining({
        op: "create",
        targetPath: [],
        box: expect.objectContaining({ id: "obj-button_0" }),
      }),
    ]);
    expect(
      result.graph?.patcher.boxes.find((box) => box.id === "obj-fx")
        ?.patcher?.connections
    ).toHaveLength(1);
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
      comment: box.comment,
      attributes: { ...box.attributes } as Readonly<Record<string, PatchSetValue>>,
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
    attributes: {},
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

function snapshotBox(
  box: PatchGraph["patcher"]["boxes"][number],
  targetPath: readonly string[],
  runtimeId: string
): MaxforgePatcherSnapshot["boxes"][number] {
  return {
    targetPath,
    runtimeId,
    varName: box.varName,
    maxclass: box.maxclass,
    patchingRect: box.patchingRect,
    managed: true,
    comment: box.comment,
    attributes: { ...box.attributes } as Readonly<Record<string, PatchSetValue>>,
    ...(box.text === undefined ? {} : { text: box.text }),
  };
}
