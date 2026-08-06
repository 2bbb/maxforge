import {
  createPatchGraph,
  diffPatchGraphs,
  managedIdFromVarName,
  PatchBox,
  PatchConnection,
  PatchGraph,
  PatchGraphNode,
  PatchPlan,
} from "../max/patch-graph.js";
import {
  mergePatchGraphs,
  PatchMergeConflict,
} from "../max/patch-merge.js";
import {
  MaxforgePatcherSnapshot,
  MaxforgeSnapshotBox,
  MaxforgeSnapshotConnection,
} from "./bridge.js";

export type PatchReconciliationConflict =
  | PatchMergeConflict
  | {
      readonly kind: "managed_identity_changed";
      readonly targetPath: readonly string[];
      readonly id?: string;
      readonly message: string;
    }
  | {
      readonly kind: "managed_box_added";
      readonly targetPath: readonly string[];
      readonly id?: string;
      readonly message: string;
    }
  | {
      readonly kind: "duplicate_managed_identity";
      readonly targetPath: readonly string[];
      readonly id?: string;
      readonly message: string;
    }
  | {
      readonly kind: "external_connection_at_risk";
      readonly targetPath: readonly string[];
      readonly id: string;
      readonly connection: MaxforgeSnapshotConnection;
      readonly message: string;
    };

export interface ReconstructedManagedState {
  readonly graph: PatchGraph;
  readonly conflicts: readonly PatchReconciliationConflict[];
  readonly externalConnections: readonly ExternalManagedConnection[];
}

export interface ReconciledPatchPlan {
  readonly graph?: PatchGraph;
  readonly liveGraph: PatchGraph;
  readonly plan?: PatchPlan;
  readonly conflicts: readonly PatchReconciliationConflict[];
}

interface ManagedSnapshotBox {
  readonly snapshot: MaxforgeSnapshotBox;
  readonly id: string;
  readonly targetPath: readonly string[];
  readonly base: PatchBox;
}

interface ManagedSnapshotEndpoint {
  readonly id: string;
  readonly varName: string;
  readonly targetPath: readonly string[];
}

export interface ExternalManagedConnection {
  readonly managed: ManagedSnapshotEndpoint;
  readonly connection: MaxforgeSnapshotConnection;
}

export function reconcilePatchGraphs(
  // The graph whose revision Max currently acknowledges and whose concrete
  // metadata is used to reconstruct the live snapshot.
  acknowledged: PatchGraph,
  // The agent's previous desired graph. It can differ from acknowledged after
  // a human edit was preserved by an earlier reconciliation.
  mergeBase: PatchGraph,
  desired: PatchGraph,
  currentSnapshot: MaxforgePatcherSnapshot,
  baselineSnapshot?: MaxforgePatcherSnapshot
): ReconciledPatchPlan {
  const reconstructed = reconstructManagedGraph(
    acknowledged,
    currentSnapshot,
    baselineSnapshot
  );
  if (reconstructed.conflicts.length > 0) {
    return {
      liveGraph: reconstructed.graph,
      conflicts: reconstructed.conflicts,
    };
  }

  const merge = mergePatchGraphs(mergeBase, reconstructed.graph, desired);
  if (!merge.graph) {
    return {
      liveGraph: reconstructed.graph,
      conflicts: merge.conflicts,
    };
  }

  const livePlan = diffLiveToMerged(reconstructed.graph, merge.graph);
  const externalConflicts = externalConnectionConflicts(
    livePlan,
    reconstructed.externalConnections
  );
  if (externalConflicts.length > 0) {
    return {
      liveGraph: reconstructed.graph,
      conflicts: externalConflicts,
    };
  }

  return {
    graph: merge.graph,
    liveGraph: reconstructed.graph,
    plan: {
      ...livePlan,
      // Manual Max edits do not advance the native optimistic-concurrency
      // revision. Authenticate against the last acknowledged graph while the
      // operations themselves describe live -> merged.
      baseRevision: acknowledged.revision,
    },
    conflicts: [],
  };
}

export function reconstructManagedGraph(
  base: PatchGraph,
  current: MaxforgePatcherSnapshot,
  baseline?: MaxforgePatcherSnapshot
): ReconstructedManagedState {
  const baseBoxes = flattenBaseBoxes(base.patcher);
  const baselineByRuntime = new Map(
    (baseline?.boxes ?? [])
      .filter((box) => box.managed)
      .map((box) => [box.runtimeId, box])
  );
  const consumed = new Set<string>();
  const conflicts: PatchReconciliationConflict[] = [];
  const managedBoxes = new Map<string, ManagedSnapshotBox>();
  const runtimeEndpoints = new Map<string, ManagedSnapshotEndpoint>();

  for (const box of current.boxes) {
    const baselineBox = baselineByRuntime.get(box.runtimeId);
    if (baselineBox && (!box.managed || box.varName !== baselineBox.varName)) {
      const id = managedIdFromVarName(base.scope, baselineBox.varName) ?? undefined;
      conflicts.push({
        kind: "managed_identity_changed",
        targetPath: baselineBox.targetPath,
        id,
        message:
          `Managed box "${id ?? baselineBox.varName}" changed or lost its ` +
          "maxforge scripting name",
      });
      continue;
    }
    if (!box.managed) continue;

    const id = managedIdFromVarName(base.scope, box.varName);
    if (!id) continue;
    const key = boxKey(box.targetPath, id);
    const baseBox = baseBoxes.get(key);
    if (!baseBox) {
      conflicts.push({
        kind: "managed_box_added",
        targetPath: box.targetPath,
        id,
        message:
          `Managed box "${id}" was added directly in Max. Add it to DSL or ` +
          "remove its reserved maxforge scripting name before merging.",
      });
      continue;
    }
    if (consumed.has(key)) {
      conflicts.push({
        kind: "duplicate_managed_identity",
        targetPath: box.targetPath,
        id,
        message: `More than one live box uses managed identity "${id}"`,
      });
      continue;
    }

    consumed.add(key);
    managedBoxes.set(key, {
      snapshot: box,
      id,
      targetPath: box.targetPath,
      base: baseBox,
    });
    runtimeEndpoints.set(box.runtimeId, {
      id,
      varName: box.varName,
      targetPath: box.targetPath,
    });
  }

  const connectionsByPath = new Map<string, PatchConnection[]>();
  const externalConnections: ExternalManagedConnection[] = [];
  for (const connection of current.connections) {
    const source = runtimeEndpoints.get(connection.source.runtimeId);
    const destination = runtimeEndpoints.get(connection.destination.runtimeId);
    if (source && destination) {
      const key = pathKey(connection.targetPath);
      const connections = connectionsByPath.get(key) ?? [];
      connections.push({
        source: {
          id: source.id,
          varName: source.varName,
          port: connection.source.port,
        },
        destination: {
          id: destination.id,
          varName: destination.varName,
          port: connection.destination.port,
        },
      });
      connectionsByPath.set(key, connections);
    } else if (source || destination) {
      externalConnections.push({
        managed: source ?? destination!,
        connection,
      });
    }
  }

  return {
    graph: createPatchGraph(
      base.scope,
      rebuildNode(base.patcher, [], managedBoxes, connectionsByPath)
    ),
    conflicts,
    externalConnections,
  };
}

function rebuildNode(
  base: PatchGraphNode,
  targetPath: readonly string[],
  liveBoxes: ReadonlyMap<string, ManagedSnapshotBox>,
  connectionsByPath: ReadonlyMap<string, readonly PatchConnection[]>
): PatchGraphNode {
  const boxes: PatchBox[] = [];
  for (const box of base.boxes) {
    const live = liveBoxes.get(boxKey(targetPath, box.id));
    if (!live) continue;
    const nestedPath = [...targetPath, box.varName];
    boxes.push({
      ...box,
      varName: live.snapshot.varName,
      maxclass: live.snapshot.maxclass,
      patchingRect: live.snapshot.patchingRect,
      text: live.snapshot.text,
      patcher: box.patcher
        ? rebuildNode(box.patcher, nestedPath, liveBoxes, connectionsByPath)
        : undefined,
    });
  }
  return {
    boxes,
    connections: connectionsByPath.get(pathKey(targetPath)) ?? [],
  };
}

function flattenBaseBoxes(
  node: PatchGraphNode,
  targetPath: readonly string[] = [],
  result = new Map<string, PatchBox>()
): Map<string, PatchBox> {
  for (const box of node.boxes) {
    result.set(boxKey(targetPath, box.id), box);
    if (box.patcher) {
      flattenBaseBoxes(box.patcher, [...targetPath, box.varName], result);
    }
  }
  return result;
}

function externalConnectionConflicts(
  plan: PatchPlan,
  externalConnections: readonly ExternalManagedConnection[]
): readonly PatchReconciliationConflict[] {
  const deleted = new Set(
    plan.operations
      .filter((operation) => operation.op === "delete")
      .map((operation) => boxKey(operation.targetPath, operation.id))
  );
  return externalConnections
    .filter((external) =>
      deleted.has(boxKey(external.managed.targetPath, external.managed.id))
    )
    .map((external) => ({
      kind: "external_connection_at_risk" as const,
      targetPath: external.managed.targetPath,
      id: external.managed.id,
      connection: external.connection,
      message:
        `Desired changes would recreate or delete managed box ` +
        `"${external.managed.id}" and destroy a live cord to an unmanaged box`,
    }));
}

function diffLiveToMerged(live: PatchGraph, merged: PatchGraph): PatchPlan {
  return diffPatchGraphs(live, merged);
}

function boxKey(targetPath: readonly string[], id: string): string {
  return `${pathKey(targetPath)}\u0000${id}`;
}

function pathKey(path: readonly string[]): string {
  return path.join("/");
}
