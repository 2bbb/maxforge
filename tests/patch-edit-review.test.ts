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
    expect(review.editClusters).toEqual([expect.objectContaining({
      id: "edit-1",
      targetPath: [],
      changeIndexes: [0, 1, 2],
      managedObjectIds: ["obj-osc"],
      unmanagedRuntimeIds: ["runtime-manual"],
      observedRuntimeIds: ["runtime-manual", "runtime-osc"],
      signalKinds: [
        "layout",
        "object_configuration",
        "object_addition",
        "routing",
      ],
      interpretationRisks: [
        "mixed_effects",
        "touches_unmanaged_state",
      ],
    })]);
    expect(review.interpretationGuidance).toEqual({
      mode: "evidence_only",
      clarificationRecommendedFor: ["edit-1"],
      instruction:
        "Use each edit cluster with conversation context as evidence; do not assert human intent. Ask only when unresolved interpretations would change the next patch mutation.",
    });
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
    expect(review.editClusters).toEqual([
      expect.objectContaining({
        id: "edit-1",
        changeIndexes: [0],
        managedObjectIds: ["obj-a"],
        signalKinds: ["layout"],
        interpretationRisks: [],
      }),
      expect.objectContaining({
        id: "edit-2",
        changeIndexes: [1],
        managedObjectIds: ["obj-b"],
        signalKinds: ["layout"],
        interpretationRisks: [],
      }),
    ]);
    expect(review.interpretationGuidance.clarificationRecommendedFor).toEqual([]);
    expect(JSON.stringify({
      signals: review.signals,
      editClusters: review.editClusters,
    })).not.toMatch(/intent|wanted|preferred/i);
    expect(review.interpretationGuidance.mode).toBe("evidence_only");
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
    expect(review.affectedUnmanagedRuntimeIds).toEqual(["runtime-osc"]);
    expect(review.signals).toEqual([expect.objectContaining({
      kind: "ownership",
      managed: true,
      objectIds: ["obj-osc", "runtime-osc"],
    })]);
    expect(review.editClusters).toEqual([expect.objectContaining({
      interpretationRisks: [
        "touches_unmanaged_state",
        "ownership_boundary_changed",
      ],
    })]);
    expect(review.interpretationGuidance.clarificationRecommendedFor).toEqual([
      "edit-1",
    ]);
  });

  it("preserves both managed identities across an ownership rename", () => {
    const before = box({
      runtimeId: "runtime-osc",
      varName: "maxforge_voices_obj_osc",
      managed: true,
    });
    const after = {
      ...before,
      varName: "maxforge_voices_obj_filter",
    };

    const review = reviewPatchEdits([{
      kind: "box_changed",
      managed: true,
      fields: ["varName"],
      before,
      after,
    }], "voices");

    expect(review.affectedManagedIds).toEqual(["obj-filter", "obj-osc"]);
    expect(review.signals).toEqual([expect.objectContaining({
      kind: "ownership",
      objectIds: ["obj-filter", "obj-osc"],
    })]);
    expect(review.editClusters).toEqual([expect.objectContaining({
      managedObjectIds: ["obj-filter", "obj-osc"],
      observedRuntimeIds: ["runtime-osc"],
      summary: "1 related change affects 1 object in the root patcher across ownership.",
    })]);
  });

  it("flags mixed managed effects as a clarification candidate", () => {
    const before = box({
      runtimeId: "runtime-osc",
      varName: "maxforge_voices_obj_osc",
      managed: true,
      text: "cycle~ 440",
    });
    const review = reviewPatchEdits([{
      kind: "box_changed",
      managed: true,
      fields: ["patchingRect", "text"],
      before,
      after: {
        ...before,
        text: "cycle~ 880",
        patchingRect: [100, 100, 80, 22],
      },
    }], "voices");

    expect(review.editClusters[0]).toMatchObject({
      interpretationRisks: ["mixed_effects"],
    });
    expect(review.interpretationGuidance.clarificationRecommendedFor).toEqual([
      "edit-1",
    ]);
  });

  it("keeps many independent changes as deterministic separate clusters", () => {
    const changes: PatchSnapshotChange[] = Array.from(
      { length: 1_000 },
      (_, index) => {
        const before = box({
          runtimeId: `runtime-${index}`,
          varName: `maxforge_voices_obj_item_${index}`,
          managed: true,
        });
        return {
          kind: "box_changed" as const,
          managed: true,
          fields: ["patchingRect"] as const,
          before,
          after: {
            ...before,
            patchingRect: [index, 100, 24, 24] as const,
          },
        };
      }
    );

    const review = reviewPatchEdits(changes, "voices");

    expect(review.editClusters).toHaveLength(1_000);
    expect(review.editClusters[0]).toMatchObject({
      id: "edit-1",
      changeIndexes: [0],
      managedObjectIds: ["obj-item_0"],
    });
    expect(review.editClusters[999]).toMatchObject({
      id: "edit-1000",
      changeIndexes: [999],
      managedObjectIds: ["obj-item_999"],
    });
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
