import { describe, expect, it } from "vitest";
import { reviewPatchEdits } from "../src/max/patch-edit-review.js";
import type { PatchSnapshotChange } from "../src/max/patch-snapshot.js";
import type {
  MaxforgeSnapshotBox,
  MaxforgeSnapshotConnection,
} from "../src/max/patch-protocol.js";

describe("reviewPatchEdits", () => {
  it("classifies raw differences as neutral evidence grouped by path", () => {
    const osc = box({
      runtimeId: "runtime-osc",
      varName: "maxforge_voices_obj_osc",
      managed: true,
      text: "cycle~ 440",
    });
    const movedOsc = {
      ...osc,
      text: "cycle~ 880",
      patchingRect: [140, 90, 80, 22] as const,
    };
    const manual = box({
      runtimeId: "runtime-manual",
      varName: "manual_meter",
      managed: false,
      maxclass: "meter~",
    });
    const changes: PatchSnapshotChange[] = [
      {
        kind: "box_changed",
        managed: true,
        fields: ["patchingRect", "text"],
        before: osc,
        after: movedOsc,
      },
      { kind: "box_added", managed: false, box: manual },
      {
        kind: "connection_added",
        managed: true,
        connection: connection(osc, manual),
      },
    ];

    const review = reviewPatchEdits(changes, "voices");

    expect(review.counts).toEqual({
      boxesAdded: 1,
      boxesRemoved: 0,
      boxesChanged: 1,
      connectionsAdded: 1,
      connectionsRemoved: 0,
      connectionsChanged: 0,
    });
    expect(review.affectedManagedIds).toEqual(["obj-osc"]);
    expect(review.affectedUnmanagedRuntimeIds).toEqual(["runtime-manual"]);
    expect(review.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "layout",
        managed: true,
        objectIds: ["obj-osc"],
        changeIndexes: [0],
      }),
      expect.objectContaining({
        kind: "object_configuration",
        managed: true,
        objectIds: ["obj-osc"],
        changeIndexes: [0],
      }),
      expect.objectContaining({
        kind: "object_addition",
        managed: false,
        objectIds: ["runtime-manual"],
        changeIndexes: [1],
      }),
      expect.objectContaining({
        kind: "routing",
        managed: true,
        objectIds: ["obj-osc", "runtime-manual"],
        changeIndexes: [2],
      }),
    ]));
  });

  it("combines repeated edits without inventing a semantic intention", () => {
    const first = box({
      runtimeId: "runtime-a",
      varName: "maxforge_voices_obj_a",
      managed: true,
    });
    const second = box({
      runtimeId: "runtime-b",
      varName: "maxforge_voices_obj_b",
      managed: true,
    });
    const changes: PatchSnapshotChange[] = [first, second].map((before) => ({
      kind: "box_changed" as const,
      managed: true,
      fields: ["patchingRect"] as const,
      before,
      after: {
        ...before,
        patchingRect: [100, 100, 24, 24] as const,
      },
    }));

    const review = reviewPatchEdits(changes, "voices");

    expect(review.signals).toEqual([expect.objectContaining({
      kind: "layout",
      objectIds: ["obj-a", "obj-b"],
      changeIndexes: [0, 1],
      summary: "Layout changed for 2 managed objects in the root patcher.",
    })]);
    expect(JSON.stringify(review)).not.toMatch(/intent|wanted|preferred/i);
  });

  it("keeps the prior managed identity when a human removes its scripting name", () => {
    const before = box({
      runtimeId: "runtime-osc",
      varName: "maxforge_voices_obj_osc",
      managed: true,
    });
    const after = { ...before, varName: "osc", managed: false };

    const review = reviewPatchEdits([{
      kind: "box_changed",
      managed: true,
      fields: ["varName", "managed"],
      before,
      after,
    }], "voices");

    expect(review.affectedManagedIds).toEqual(["obj-osc"]);
    expect(review.signals).toEqual([expect.objectContaining({
      kind: "ownership",
      managed: true,
      objectIds: ["obj-osc"],
    })]);
  });
});

function box(
  values: Partial<MaxforgeSnapshotBox> & Pick<MaxforgeSnapshotBox, "runtimeId" | "varName" | "managed">
): MaxforgeSnapshotBox {
  return {
    targetPath: [],
    maxclass: "button",
    patchingRect: [50, 50, 24, 24],
    attributes: {},
    ...values,
  };
}

function connection(
  source: MaxforgeSnapshotBox,
  destination: MaxforgeSnapshotBox
): MaxforgeSnapshotConnection {
  return {
    targetPath: [],
    source: {
      runtimeId: source.runtimeId,
      varName: source.varName,
      port: 0,
    },
    destination: {
      runtimeId: destination.runtimeId,
      varName: destination.varName,
      port: 0,
    },
    attributes: {},
  };
}
