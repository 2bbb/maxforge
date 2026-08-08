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

export interface PatchEditReview {
  readonly counts: PatchEditCounts;
  readonly affectedManagedIds: readonly string[];
  readonly affectedUnmanagedRuntimeIds: readonly string[];
  readonly signals: readonly PatchEditSignal[];
}

interface MutableSignal {
  readonly kind: PatchEditSignalKind;
  readonly managed: boolean;
  readonly targetPath: readonly string[];
  readonly objectIds: Set<string>;
  readonly changeIndexes: number[];
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
        for (const kind of kinds) {
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
  recordIdentity(id, managed, managedIds, unmanagedRuntimeIds);
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
