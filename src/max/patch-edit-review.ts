import { managedIdFromVarName } from "./patch-graph.js";
import type { PatchSnapshotChange } from "./patch-snapshot.js";
import type {
  MaxforgeSnapshotBox,
  MaxforgeSnapshotConnection,
} from "./patch-protocol.js";

export type PatchEditSignalKind =
  | "layout"
  | "object_configuration"
  | "annotation"
  | "box_attributes"
  | "ownership"
  | "object_addition"
  | "object_removal"
  | "routing"
  | "connection_attributes";

export interface PatchEditSignal {
  readonly kind: PatchEditSignalKind;
  readonly managed: boolean;
  readonly targetPath: readonly string[];
  readonly objectIds: readonly string[];
  readonly changeIndexes: readonly number[];
  readonly summary: string;
}

export interface PatchEditCounts {
  readonly boxesAdded: number;
  readonly boxesRemoved: number;
  readonly boxesChanged: number;
  readonly connectionsAdded: number;
  readonly connectionsRemoved: number;
  readonly connectionsChanged: number;
}

export type PatchEditInterpretationRisk =
  | "mixed_effects"
  | "touches_unmanaged_state"
  | "ownership_boundary_changed";

export interface PatchEditCluster {
  readonly id: string;
  readonly targetPath: readonly string[];
  readonly changeIndexes: readonly number[];
  readonly managedObjectIds: readonly string[];
  readonly unmanagedRuntimeIds: readonly string[];
  readonly observedRuntimeIds: readonly string[];
  readonly signalKinds: readonly PatchEditSignalKind[];
  readonly interpretationRisks: readonly PatchEditInterpretationRisk[];
  readonly summary: string;
}

export interface PatchEditInterpretationGuidance {
  readonly mode: "evidence_only";
  readonly clarificationRecommendedFor: readonly string[];
  readonly instruction: string;
}

export interface PatchEditReview {
  readonly counts: PatchEditCounts;
  readonly affectedManagedIds: readonly string[];
  readonly affectedUnmanagedRuntimeIds: readonly string[];
  readonly signals: readonly PatchEditSignal[];
  readonly editClusters: readonly PatchEditCluster[];
  readonly interpretationGuidance: PatchEditInterpretationGuidance;
}

interface MutableSignal {
  readonly kind: PatchEditSignalKind;
  readonly managed: boolean;
  readonly targetPath: readonly string[];
  readonly objectIds: Set<string>;
  readonly changeIndexes: number[];
}

interface ChangeEvidence {
  readonly changeIndex: number;
  readonly targetPath: readonly string[];
  readonly managedObjectIds: readonly string[];
  readonly unmanagedRuntimeIds: readonly string[];
  readonly observedRuntimeIds: readonly string[];
  readonly signalKinds: readonly PatchEditSignalKind[];
}

/**
 * Convert raw snapshot differences into neutral, agent-readable evidence.
 * Signals classify what changed; they deliberately do not claim why a human
 * changed it.
 */
export function reviewPatchEdits(
  changes: readonly PatchSnapshotChange[],
  scope: string
): PatchEditReview {
  const counts: Mutable<PatchEditCounts> = {
    boxesAdded: 0,
    boxesRemoved: 0,
    boxesChanged: 0,
    connectionsAdded: 0,
    connectionsRemoved: 0,
    connectionsChanged: 0,
  };
  const signals = new Map<string, MutableSignal>();
  const managedIds = new Set<string>();
  const unmanagedRuntimeIds = new Set<string>();

  changes.forEach((change, changeIndex) => {
    switch (change.kind) {
      case "box_added":
        counts.boxesAdded++;
        addBoxSignal(
          signals,
          "object_addition",
          change.box,
          change.managed,
          scope,
          changeIndex,
          managedIds,
          unmanagedRuntimeIds
        );
        return;
      case "box_removed":
        counts.boxesRemoved++;
        addBoxSignal(
          signals,
          "object_removal",
          change.box,
          change.managed,
          scope,
          changeIndex,
          managedIds,
          unmanagedRuntimeIds
        );
        return;
      case "box_changed": {
        counts.boxesChanged++;
        const box = change.after.managed ? change.after : change.before;
        for (const kind of signalKindsForChange(change)) {
          if (kind === "ownership") {
            addOwnershipSignal(
              signals,
              change,
              scope,
              changeIndex,
              managedIds,
              unmanagedRuntimeIds
            );
            continue;
          }
          addBoxSignal(
            signals,
            kind,
            box,
            change.managed,
            scope,
            changeIndex,
            managedIds,
            unmanagedRuntimeIds
          );
        }
        return;
      }
      case "connection_added":
        counts.connectionsAdded++;
        addConnectionSignal(
          signals,
          "routing",
          change.connection,
          change.managed,
          scope,
          changeIndex,
          managedIds,
          unmanagedRuntimeIds
        );
        return;
      case "connection_removed":
        counts.connectionsRemoved++;
        addConnectionSignal(
          signals,
          "routing",
          change.connection,
          change.managed,
          scope,
          changeIndex,
          managedIds,
          unmanagedRuntimeIds
        );
        return;
      case "connection_changed":
        counts.connectionsChanged++;
        addConnectionSignal(
          signals,
          "connection_attributes",
          change.after,
          change.managed,
          scope,
          changeIndex,
          managedIds,
          unmanagedRuntimeIds
        );
    }
  });

  const editClusters = buildEditClusters(
    changes.map((change, changeIndex) =>
      describeChange(change, changeIndex, scope)
    )
  );

  return {
    counts,
    affectedManagedIds: [...managedIds].sort(),
    affectedUnmanagedRuntimeIds: [...unmanagedRuntimeIds].sort(),
    signals: [...signals.values()]
      .sort((left, right) => signalKey(left).localeCompare(signalKey(right)))
      .map((signal) => ({
        kind: signal.kind,
        managed: signal.managed,
        targetPath: signal.targetPath,
        objectIds: [...signal.objectIds].sort(),
        changeIndexes: [...new Set(signal.changeIndexes)].sort((a, b) => a - b),
        summary: signalSummary(signal),
      })),
    editClusters,
    interpretationGuidance: {
      mode: "evidence_only",
      clarificationRecommendedFor: editClusters
        .filter((cluster) => cluster.interpretationRisks.length > 0)
        .map((cluster) => cluster.id),
      instruction:
        "Use each edit cluster with conversation context as evidence; do not assert human intent. Ask only when unresolved interpretations would change the next patch mutation.",
    },
  };
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

function addBoxSignal(
  signals: Map<string, MutableSignal>,
  kind: PatchEditSignalKind,
  box: MaxforgeSnapshotBox,
  managed: boolean,
  scope: string,
  changeIndex: number,
  managedIds: Set<string>,
  unmanagedRuntimeIds: Set<string>
): void {
  const id = objectIdentity(box, managed, scope);
  recordBoxIdentity(
    box,
    managed,
    scope,
    managedIds,
    unmanagedRuntimeIds
  );
  addSignal(signals, kind, managed, box.targetPath, [id], changeIndex);
}

function addConnectionSignal(
  signals: Map<string, MutableSignal>,
  kind: PatchEditSignalKind,
  connection: MaxforgeSnapshotConnection,
  managed: boolean,
  scope: string,
  changeIndex: number,
  managedIds: Set<string>,
  unmanagedRuntimeIds: Set<string>
): void {
  const ids = [connection.source, connection.destination].map((endpoint) => {
    const managedId = managedIdFromVarName(scope, endpoint.varName);
    const endpointManaged = managedId !== null;
    const id = managedId ?? endpoint.runtimeId;
    recordIdentity(id, endpointManaged, managedIds, unmanagedRuntimeIds);
    return id;
  });
  addSignal(
    signals,
    kind,
    managed,
    connection.targetPath,
    ids,
    changeIndex
  );
}

function addOwnershipSignal(
  signals: Map<string, MutableSignal>,
  change: Extract<PatchSnapshotChange, { readonly kind: "box_changed" }>,
  scope: string,
  changeIndex: number,
  managedIds: Set<string>,
  unmanagedRuntimeIds: Set<string>
): void {
  const identities = [change.before, change.after].map((box) =>
    snapshotBoxIdentity(box, scope)
  );
  for (const identity of identities) {
    recordBoxIdentity(
      identity.box,
      identity.managed,
      scope,
      managedIds,
      unmanagedRuntimeIds
    );
  }
  addSignal(
    signals,
    "ownership",
    change.managed,
    change.before.targetPath,
    identities.map((identity) => identity.id),
    changeIndex
  );
}

function addSignal(
  signals: Map<string, MutableSignal>,
  kind: PatchEditSignalKind,
  managed: boolean,
  targetPath: readonly string[],
  objectIds: readonly string[],
  changeIndex: number
): void {
  const key = `${kind}\u0000${managed ? "managed" : "unmanaged"}\u0000${targetPath.join("/")}`;
  const signal = signals.get(key) ?? {
    kind,
    managed,
    targetPath: [...targetPath],
    objectIds: new Set<string>(),
    changeIndexes: [],
  };
  for (const id of objectIds) signal.objectIds.add(id);
  signal.changeIndexes.push(changeIndex);
  signals.set(key, signal);
}

function objectIdentity(
  box: MaxforgeSnapshotBox,
  managed: boolean,
  scope: string
): string {
  if (managed) return managedIdFromVarName(scope, box.varName) ?? box.runtimeId;
  return box.runtimeId;
}

function snapshotBoxIdentity(
  box: MaxforgeSnapshotBox,
  scope: string
): {
  readonly box: MaxforgeSnapshotBox;
  readonly id: string;
  readonly managed: boolean;
} {
  if (box.managed) {
    return {
      box,
      id: managedIdFromVarName(scope, box.varName) ?? box.runtimeId,
      managed: true,
    };
  }
  return { box, id: box.runtimeId, managed: false };
}

function recordBoxIdentity(
  box: MaxforgeSnapshotBox,
  managed: boolean,
  scope: string,
  managedIds: Set<string>,
  unmanagedRuntimeIds: Set<string>
): void {
  if (managed) {
    const managedId = managedIdFromVarName(scope, box.varName);
    if (managedId !== null) managedIds.add(managedId);
    return;
  }
  unmanagedRuntimeIds.add(box.runtimeId);
}

function recordIdentity(
  id: string,
  managed: boolean,
  managedIds: Set<string>,
  unmanagedRuntimeIds: Set<string>
): void {
  (managed ? managedIds : unmanagedRuntimeIds).add(id);
}

function signalKey(signal: MutableSignal): string {
  return `${signal.targetPath.join("/")}\u0000${signal.kind}\u0000${signal.managed ? 0 : 1}`;
}

function signalSummary(signal: MutableSignal): string {
  const count = signal.objectIds.size;
  const ownership = signal.managed ? "managed" : "unmanaged";
  const location = signal.targetPath.length === 0
    ? "the root patcher"
    : `subpatcher ${signal.targetPath.join("/")}`;
  const subject = count === 1 ? "object" : "objects";
  switch (signal.kind) {
    case "layout":
      return `Layout changed for ${count} ${ownership} ${subject} in ${location}.`;
    case "object_configuration":
      return `Object configuration changed for ${count} ${ownership} ${subject} in ${location}.`;
    case "annotation":
      return `Annotation changed for ${count} ${ownership} ${subject} in ${location}.`;
    case "box_attributes":
      return `Box attributes changed for ${count} ${ownership} ${subject} in ${location}.`;
    case "ownership":
      return `Ownership identity changed for ${count} ${ownership} ${subject} in ${location}.`;
    case "object_addition":
      return `${count} ${ownership} ${subject} added in ${location}.`;
    case "object_removal":
      return `${count} ${ownership} ${subject} removed from ${location}.`;
    case "routing":
      return signal.managed
        ? `Routing touching managed state changed across ${count} ${subject} in ${location}.`
        : `Routing outside managed state changed across ${count} ${subject} in ${location}.`;
    case "connection_attributes":
      return signal.managed
        ? `Patch-cord attributes touching managed state changed across ${count} ${subject} in ${location}.`
        : `Patch-cord attributes outside managed state changed across ${count} ${subject} in ${location}.`;
  }
}

function describeChange(
  change: PatchSnapshotChange,
  changeIndex: number,
  scope: string
): ChangeEvidence {
  if (
    change.kind === "box_added" ||
    change.kind === "box_removed" ||
    change.kind === "box_changed"
  ) {
    const box = change.kind === "box_changed"
      ? (change.after.managed ? change.after : change.before)
      : change.box;
    const ownershipChanged = change.kind === "box_changed" &&
      change.fields.some((field) => field === "varName" || field === "managed");
    const boxes = ownershipChanged
      ? [change.before, change.after]
      : [box];
    return {
      changeIndex,
      targetPath: box.targetPath,
      managedObjectIds: uniqueSorted(
        boxes.flatMap((item) => {
          if (!item.managed) return [];
          const managedId = managedIdFromVarName(scope, item.varName);
          return managedId === null ? [] : [managedId];
        })
      ),
      unmanagedRuntimeIds: uniqueSorted(
        boxes.filter((item) => !item.managed)
          .map((item) => item.runtimeId)
      ),
      observedRuntimeIds: uniqueSorted(
        boxes.map((item) => item.runtimeId)
      ),
      signalKinds: signalKindsForChange(change),
    };
  }

  const connection = change.kind === "connection_changed"
    ? change.after
    : change.connection;
  const managedObjectIds: string[] = [];
  const unmanagedRuntimeIds: string[] = [];
  for (const endpoint of [connection.source, connection.destination]) {
    const managedId = managedIdFromVarName(scope, endpoint.varName);
    if (managedId === null) unmanagedRuntimeIds.push(endpoint.runtimeId);
    else managedObjectIds.push(managedId);
  }
  return {
    changeIndex,
    targetPath: connection.targetPath,
    managedObjectIds: [...new Set(managedObjectIds)].sort(),
    unmanagedRuntimeIds: [...new Set(unmanagedRuntimeIds)].sort(),
    observedRuntimeIds: uniqueSorted([
      connection.source.runtimeId,
      connection.destination.runtimeId,
    ]),
    signalKinds: signalKindsForChange(change),
  };
}

function signalKindsForChange(
  change: PatchSnapshotChange
): readonly PatchEditSignalKind[] {
  if (change.kind === "box_added") return ["object_addition"];
  if (change.kind === "box_removed") return ["object_removal"];
  if (
    change.kind === "connection_added" ||
    change.kind === "connection_removed"
  ) {
    return ["routing"];
  }
  if (change.kind === "connection_changed") {
    return ["connection_attributes"];
  }

  const kinds = new Set<PatchEditSignalKind>();
  for (const field of change.fields) {
    if (field === "patchingRect") kinds.add("layout");
    else if (field === "text" || field === "maxclass") {
      kinds.add("object_configuration");
    } else if (field === "comment") kinds.add("annotation");
    else if (field === "attributes") kinds.add("box_attributes");
    else if (field === "varName" || field === "managed") {
      kinds.add("ownership");
    }
  }
  return [...kinds];
}

function buildEditClusters(
  evidence: readonly ChangeEvidence[]
): readonly PatchEditCluster[] {
  const parents = evidence.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const firstChangeByIdentity = new Map<string, number>();
  evidence.forEach((item, index) => {
    const path = JSON.stringify(item.targetPath);
    for (const identity of evidenceIdentityKeys(item)) {
      const key = `${path}\u0000${identity}`;
      const previous = firstChangeByIdentity.get(key);
      if (previous !== undefined) union(previous, index);
      else firstChangeByIdentity.set(key, index);
    }
  });

  const grouped = new Map<number, ChangeEvidence[]>();
  evidence.forEach((item, index) => {
    const root = find(index);
    const group = grouped.get(root) ?? [];
    group.push(item);
    grouped.set(root, group);
  });

  return [...grouped.values()]
    .sort((left, right) => left[0].changeIndex - right[0].changeIndex)
    .map((group, index) => createEditCluster(group, index + 1));
}

function evidenceIdentityKeys(evidence: ChangeEvidence): readonly string[] {
  return [
    ...evidence.observedRuntimeIds.map((id) => `runtime:${id}`),
    ...evidence.managedObjectIds.map((id) => `managed:${id}`),
    ...evidence.unmanagedRuntimeIds.map((id) => `unmanaged:${id}`),
  ];
}

function createEditCluster(
  evidence: readonly ChangeEvidence[],
  sequence: number
): PatchEditCluster {
  const managedObjectIds = uniqueSorted(
    evidence.flatMap((item) => item.managedObjectIds)
  );
  const unmanagedRuntimeIds = uniqueSorted(
    evidence.flatMap((item) => item.unmanagedRuntimeIds)
  );
  const signalKinds = uniqueInOrder(
    evidence.flatMap((item) => item.signalKinds)
  );
  const observedRuntimeIds = uniqueSorted(
    evidence.flatMap((item) => item.observedRuntimeIds)
  );
  const interpretationRisks: PatchEditInterpretationRisk[] = [];
  if (signalKinds.length > 1) interpretationRisks.push("mixed_effects");
  if (unmanagedRuntimeIds.length > 0) {
    interpretationRisks.push("touches_unmanaged_state");
  }
  if (signalKinds.includes("ownership")) {
    interpretationRisks.push("ownership_boundary_changed");
  }
  const targetPath = evidence[0].targetPath;
  const location = targetPath.length === 0
    ? "the root patcher"
    : `subpatcher ${targetPath.join("/")}`;
  const affectedCount = observedRuntimeIds.length;
  return {
    id: `edit-${sequence}`,
    targetPath,
    changeIndexes: evidence.map((item) => item.changeIndex).sort((a, b) => a - b),
    managedObjectIds,
    unmanagedRuntimeIds,
    observedRuntimeIds,
    signalKinds,
    interpretationRisks,
    summary:
      `${evidence.length} related ${evidence.length === 1 ? "change" : "changes"} ` +
      `${affectedCount === 1 ? "affects" : "affect"} ${affectedCount} ` +
      `${affectedCount === 1 ? "object" : "objects"} in ${location} across ` +
      `${signalKinds.join(", ")}.`,
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function uniqueInOrder<Value>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)];
}
