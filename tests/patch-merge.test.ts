import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  compileDslToPatchGraph,
  mergePatchGraphs,
  PatchGraph,
} from "../src/index.js";

const database = dbData as ObjectDatabase;

describe("managed patch graph three-way merge", () => {
  it("preserves a live text edit while applying an independent desired addition", () => {
    const base = graph("osc = cycle~ 440");
    const live = graph("osc = cycle~ 880");
    const desired = graph("osc = cycle~ 440\ngain = *~ 0.25");

    const result = mergePatchGraphs(base, live, desired);

    expect(result.conflicts).toEqual([]);
    expect(result.graph?.patcher.boxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "obj-osc", text: "cycle~ 880" }),
        expect.objectContaining({ id: "obj-gain", text: "*~ 0.25" }),
      ])
    );
  });

  it("merges a live position edit with a desired text edit on the same box", () => {
    const base = graph("osc = cycle~ 440 at(10, 20)");
    const live = graph("osc = cycle~ 440 at(80, 90)");
    const desired = graph("osc = cycle~ 880 at(10, 20)");

    const result = mergePatchGraphs(base, live, desired);

    expect(result.conflicts).toEqual([]);
    expect(result.graph?.patcher.boxes[0]).toMatchObject({
      text: "cycle~ 880",
      patchingRect: [80, 90, 80, 22],
    });
  });

  it("reports a field conflict when Max and desired DSL change text differently", () => {
    const base = graph("osc = cycle~ 440");
    const live = graph("osc = cycle~ 660");
    const desired = graph("osc = cycle~ 880");

    const result = mergePatchGraphs(base, live, desired);

    expect(result.graph).toBeUndefined();
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "box_field",
        id: "obj-osc",
        field: "text",
      }),
    ]);
  });

  it("reports deletion against a concurrent box change", () => {
    const base = graph("osc = cycle~ 440");
    const live = graph("");
    const desired = graph("osc = cycle~ 880");

    const result = mergePatchGraphs(base, live, desired);

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "box_delete_vs_change",
        id: "obj-osc",
      }),
    ]);
  });

  it("preserves a live connection removal when desired changes another box", () => {
    const base = graph("osc = cycle~ 440\ngain = *~ 0.25\nosc -> gain");
    const live = graph("osc = cycle~ 440\ngain = *~ 0.25");
    const desired = graph("osc = cycle~ 440\ngain = *~ 0.5\nosc -> gain");

    const result = mergePatchGraphs(base, live, desired);

    expect(result.conflicts).toEqual([]);
    expect(result.graph?.patcher.connections).toEqual([]);
    expect(result.graph?.patcher.boxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "obj-gain", text: "*~ 0.5" }),
      ])
    );
  });

  it("reports a preserved connection whose endpoint was concurrently deleted", () => {
    const base = graph(
      "osc = cycle~ 440 at(10, 20)\ngain = *~ 0.25 at(10, 80)"
    );
    const live = graph(
      "osc = cycle~ 440 at(10, 20)\ngain = *~ 0.25 at(10, 80)\nosc -> gain"
    );
    const desired = graph("gain = *~ 0.25 at(10, 80)");

    const result = mergePatchGraphs(base, live, desired);

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "connection_vs_box_delete",
        connection: expect.objectContaining({
          source: expect.objectContaining({ id: "obj-osc" }),
        }),
      }),
    ]);
  });
});

function graph(source: string): PatchGraph {
  const result = compileDslToPatchGraph(source, database, "voices");
  expect(result.errors).toEqual([]);
  return result.graph!;
}
