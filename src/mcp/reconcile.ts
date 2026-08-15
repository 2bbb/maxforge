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
} from "../max/patch-protocol.js";
import { resolveSnapshotAttributes } from "../max/patch-snapshot.js";

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
    }
  | {
      readonly kind: "unrepresentable_graph";
      readonly targetPath: readonly string[];
      readonly message: string;
    };

export interface ReconstructedManagedState {
  readonly graph: PatchGraph;
  readonly conflicts: readonly PatchReconciliationConflict[];
  readonly externalConnections: readonly ExternalManagedConnection[];
  readonly recoveredManagedKeys: ReadonlySet<string>;
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
  readonly box: PatchBox;
}

export type LiveSnapshotBoxResolver = (
  snapshot: MaxforgeSnapshotBox,
  base: PatchBox,
  baseline?: MaxforgeSnapshotBox
) => PatchBox;

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
  baselineSnapshot?: MaxforgePatcherSnapshot,
  resolveBox?: LiveSnapshotBoxResolver
): ReconciledPatchPlan {
  const reconstructed = reconstructManagedGraph(
    acknowledged,
    currentSnapshot,
    baselineSnapshot,
    resolveBox,
    desired
  );
  if (reconstructed.conflicts.length > 0) {
    return {
      liveGraph: reconstructed.graph,
      conflicts: reconstructed.conflicts,
    };
  }

  const recoveryConflicts = validateRecoveredManagedAdditions(
    reconstructed,
    desired
  );
  if (recoveryConflicts.length > 0) {
    return {
      liveGraph: reconstructed.graph,
      conflicts: recoveryConflicts,
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
  baseline?: MaxforgePatcherSnapshot,
  resolveBox: LiveSnapshotBoxResolver = defaultLiveBox,
  recovery?: PatchGraph
): ReconstructedManagedState {
  const baseBoxes = flattenBaseBoxes(base.patcher);
  const recoveryBoxes = recovery
    ? flattenBaseBoxes(recovery.patcher)
    : new Map<string, PatchBox>();
  const baselineByRuntime = new Map(
    (baseline?.boxes ?? [])
      .filter((box) => box.managed)
      .map((box) => [runtimeKey(box.targetPath, box.runtimeId), box])
  );
  const consumed = new Set<string>();
  const conflicts: PatchReconciliationConflict[] = [];
  const managedBoxes = new Map<string, ManagedSnapshotBox>();
  const runtimeEndpoints = new Map<string, ManagedSnapshotEndpoint>();
  const recoveredManagedKeys = new Set<string>();

  for (const box of current.boxes) {
    const baselineBox = baselineByRuntime.get(
      runtimeKey(box.targetPath, box.runtimeId)
    );
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
    const recoveryBox = recoveryBoxes.get(key);
    const referenceBox = baseBox ?? recoveryBox;
    if (!referenceBox) {
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
    if (!baseBox) recoveredManagedKeys.add(key);
    managedBoxes.set(key, {
      snapshot: box,
      id,
      targetPath: box.targetPath,
      box: resolveBox(box, referenceBox, baselineBox),
    });
    runtimeEndpoints.set(runtimeKey(box.targetPath, box.runtimeId), {
      id,
      varName: box.varName,
      targetPath: box.targetPath,
    });
  }

  const connectionsByPath = new Map<string, PatchConnection[]>();
  const externalConnections: ExternalManagedConnection[] = [];
  for (const connection of current.connections) {
    const source = runtimeEndpoints.get(
      runtimeKey(connection.targetPath, connection.source.runtimeId)
    );
    const destination = runtimeEndpoints.get(
      runtimeKey(connection.targetPath, connection.destination.runtimeId)
    );
    if (source && destination) {
      if (
        (
          recoveredManagedKeys.has(boxKey(source.targetPath, source.id)) ||
          recoveredManagedKeys.has(boxKey(destination.targetPath, destination.id))
        ) &&
        Object.keys(connection.attributes).length > 0
      ) {
        conflicts.push({
          kind: "unrepresentable_graph",
          targetPath: connection.targetPath,
          message:
            "A live cord involving a recovered managed box has metadata that " +
            "protocol version 1 cannot represent",
        });
      }
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
      rebuildNode(
        reconstructionTemplate(base.patcher, recovery?.patcher),
        [],
        managedBoxes,
        connectionsByPath
      )
    ),
    conflicts,
    externalConnections,
    recoveredManagedKeys,
  };
}

function validateRecoveredManagedAdditions(
  reconstructed: ReconstructedManagedState,
  desired: PatchGraph
): readonly PatchReconciliationConflict[] {
  if (reconstructed.recoveredManagedKeys.size === 0) return [];

  const conflicts: PatchReconciliationConflict[] = [];
  const liveBoxes = flattenBaseBoxes(reconstructed.graph.patcher);
  const desiredBoxes = flattenBaseBoxes(desired.patcher);
  for (const key of reconstructed.recoveredManagedKeys) {
    const liveBox = liveBoxes.get(key);
    const desiredBox = desiredBoxes.get(key);
    if (
      liveBox &&
      desiredBox &&
      samePatchBox(desired.scope, liveBox, desiredBox)
    ) continue;
    const separator = key.lastIndexOf("\u0000");
    conflicts.push({
      kind: "box_concurrent_add",
      targetPath: pathFromKey(key.slice(0, separator)),
      id: key.slice(separator + 1),
      message:
        `Managed box "${key.slice(separator + 1)}" was added differently ` +
        "in Max and complete desired DSL",
    });
  }
  for (const external of reconstructed.externalConnections) {
    const key = boxKey(external.managed.targetPath, external.managed.id);
    if (!reconstructed.recoveredManagedKeys.has(key)) continue;
    conflicts.push({
      kind: "external_connection_at_risk",
      targetPath: external.managed.targetPath,
      id: external.managed.id,
      connection: external.connection,
      message:
        `Managed box "${external.managed.id}" cannot be recovered from ` +
        "desired DSL while it has a live cord to an unmanaged box",
    });
  }

  const liveConnections = recoveredConnectionKeys(
    reconstructed.graph,
    reconstructed.recoveredManagedKeys
  );
  const desiredConnections = recoveredConnectionKeys(
    desired,
    reconstructed.recoveredManagedKeys
  );
  if (!equalStringSets(liveConnections, desiredConnections)) {
    const firstKey = [...reconstructed.recoveredManagedKeys].sort()[0];
    const separator = firstKey.lastIndexOf("\u0000");
    conflicts.push({
      kind: "box_concurrent_add",
      targetPath: pathFromKey(firstKey.slice(0, separator)),
      id: firstKey.slice(separator + 1),
      message:
        "Live connections involving recovered managed boxes do not exactly " +
        "match complete desired DSL",
    });
  }
  return conflicts;
}

function samePatchBox(
  scope: string,
  left: PatchBox,
  right: PatchBox
): boolean {
  return createPatchGraph(scope, {
    boxes: [left],
    connections: [],
  }).revision === createPatchGraph(scope, {
    boxes: [right],
    connections: [],
  }).revision;
}

function reconstructionTemplate(
  base: PatchGraphNode,
  recovery?: PatchGraphNode
): PatchGraphNode {
  if (!recovery) return base;
  const recoveryById = new Map(recovery.boxes.map((box) => [box.id, box]));
  const boxes = base.boxes.map((box) => {
    const recovered = recoveryById.get(box.id);
    recoveryById.delete(box.id);
    if (!box.patcher && !recovered?.patcher) return box;
    return {
      ...box,
      patcher: reconstructionTemplate(
        box.patcher ?? { boxes: [], connections: [] },
        recovered?.patcher
      ),
    };
  });
  boxes.push(...recovery.boxes.filter((box) => recoveryById.has(box.id)));
  return { boxes, connections: base.connections };
}

function recoveredConnectionKeys(
  graph: PatchGraph,
  recoveredManagedKeys: ReadonlySet<string>
): Set<string> {
  const result = new Set<string>();
  collectRecoveredConnectionKeys(
    graph.patcher,
    [],
    recoveredManagedKeys,
    result
  );
  return result;
}

function collectRecoveredConnectionKeys(
  node: PatchGraphNode,
  targetPath: readonly string[],
  recoveredManagedKeys: ReadonlySet<string>,
  result: Set<string>
): void {
  for (const connection of node.connections) {
    const sourceKey = boxKey(targetPath, connection.source.id);
    const destinationKey = boxKey(targetPath, connection.destination.id);
    if (
      !recoveredManagedKeys.has(sourceKey) &&
      !recoveredManagedKeys.has(destinationKey)
    ) continue;
    result.add([
      pathKey(targetPath),
      connection.source.id,
      connection.source.port,
      connection.destination.id,
      connection.destination.port,
    ].join("\u0000"));
  }
  for (const box of node.boxes) {
    if (!box.patcher) continue;
    collectRecoveredConnectionKeys(
      box.patcher,
      [...targetPath, box.varName],
      recoveredManagedKeys,
      result
    );
  }
}

function equalStringSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function pathFromKey(key: string): readonly string[] {
  return key === "" ? [] : key.split("/");
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
      ...live.box,
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

function defaultLiveBox(
  snapshot: MaxforgeSnapshotBox,
  base: PatchBox,
  baseline?: MaxforgeSnapshotBox
): PatchBox {
  return {
    ...base,
    varName: snapshot.varName,
    maxclass: snapshot.maxclass,
    patchingRect: snapshot.patchingRect,
    text: snapshotText(snapshot),
    comment: snapshot.comment,
    attributes: resolveSnapshotAttributes(snapshot, base, baseline),
  };
}

function snapshotText(snapshot: MaxforgeSnapshotBox): string | undefined {
  // Max inspection exposes runtime display/value text for native UI boxes such
  // as number and flonum. That value is not a serialized box text field and
  // the DSL cannot represent it as one. Only classes whose DSL form owns a
  // structural text field may contribute snapshot.text to the managed graph.
  return snapshot.maxclass === "newobj" ||
      snapshot.maxclass === "message" ||
      snapshot.maxclass === "comment"
    ? snapshot.text
    : undefined;
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

function runtimeKey(targetPath: readonly string[], runtimeId: string): string {
  return `${pathKey(targetPath)}\u0000${runtimeId}`;
}
