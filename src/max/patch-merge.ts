import {
  createPatchGraph,
  PatchBox,
  PatchConnection,
  PatchGraph,
  PatchGraphNode,
  PatchValue,
} from "./patch-graph.js";

export type PatchMergeConflictKind =
  | "box_field"
  | "box_delete_vs_change"
  | "box_change_vs_delete"
  | "box_concurrent_add"
  | "connection_vs_box_delete";

export interface PatchMergeConflict {
  readonly kind: PatchMergeConflictKind;
  readonly targetPath: readonly string[];
  readonly id?: string;
  readonly field?: PatchBoxField;
  readonly connection?: PatchConnection;
  readonly message: string;
}

export interface PatchMergeResult {
  readonly graph?: PatchGraph;
  readonly conflicts: readonly PatchMergeConflict[];
}

type PatchBoxField =
  | "varName"
  | "maxclass"
  | "numinlets"
  | "numoutlets"
  | "outlettype"
  | "patchingRect"
  | "text"
  | "comment"
  | "attributes";

const BOX_FIELDS: readonly PatchBoxField[] = [
  "varName",
  "maxclass",
  "numinlets",
  "numoutlets",
  "outlettype",
  "patchingRect",
  "text",
  "comment",
  "attributes",
];

/**
 * Merge independent live-Max and desired-DSL edits against the last
 * acknowledged managed graph. Conflicts are reported instead of choosing a
 * winner when both sides changed the same field or one side changed a box the
 * other side deleted.
 */
export function mergePatchGraphs(
  base: PatchGraph,
  live: PatchGraph,
  desired: PatchGraph
): PatchMergeResult {
  if (base.scope !== live.scope || base.scope !== desired.scope) {
    throw new Error("Cannot merge patch graphs with different scopes");
  }

  const conflicts: PatchMergeConflict[] = [];
  const patcher = mergeNode(
    base.patcher,
    live.patcher,
    desired.patcher,
    [],
    conflicts
  );
  if (conflicts.length > 0) return { conflicts: sortConflicts(conflicts) };

  return {
    graph: createPatchGraph(base.scope, patcher),
    conflicts: [],
  };
}

function mergeNode(
  base: PatchGraphNode,
  live: PatchGraphNode,
  desired: PatchGraphNode,
  targetPath: readonly string[],
  conflicts: PatchMergeConflict[]
): PatchGraphNode {
  const baseBoxes = boxesById(base.boxes);
  const liveBoxes = boxesById(live.boxes);
  const desiredBoxes = boxesById(desired.boxes);
  const mergedBoxes: PatchBox[] = [];
  const ids = new Set([
    ...baseBoxes.keys(),
    ...liveBoxes.keys(),
    ...desiredBoxes.keys(),
  ]);

  for (const id of [...ids].sort()) {
    const baseBox = baseBoxes.get(id);
    const liveBox = liveBoxes.get(id);
    const desiredBox = desiredBoxes.get(id);
    const merged = mergeBox(
      baseBox,
      liveBox,
      desiredBox,
      targetPath,
      conflicts
    );
    if (merged) mergedBoxes.push(merged);
  }

  const mergedIds = new Set(mergedBoxes.map((box) => box.id));
  const mergedConnections = mergeConnections(
    base.connections,
    live.connections,
    desired.connections
  );
  const validConnections: PatchConnection[] = [];
  for (const connection of mergedConnections) {
    if (
      mergedIds.has(connection.source.id) &&
      mergedIds.has(connection.destination.id)
    ) {
      validConnections.push(connection);
      continue;
    }
    conflicts.push({
      kind: "connection_vs_box_delete",
      targetPath,
      connection,
      message:
        `Connection ${connectionLabel(connection)} was preserved by one side ` +
        "while its endpoint box was deleted by the other",
    });
  }

  return { boxes: mergedBoxes, connections: validConnections };
}

function mergeBox(
  base: PatchBox | undefined,
  live: PatchBox | undefined,
  desired: PatchBox | undefined,
  targetPath: readonly string[],
  conflicts: PatchMergeConflict[]
): PatchBox | undefined {
  if (!base) {
    if (!live) return desired;
    if (!desired) return live;
    if (equalBox(live, desired)) return live;
    conflicts.push({
      kind: "box_concurrent_add",
      targetPath,
      id: live.id,
      message: `Box "${live.id}" was added differently in Max and desired DSL`,
    });
    return undefined;
  }

  if (!live && !desired) return undefined;
  if (!live && desired) {
    if (equalBox(base, desired)) return undefined;
    conflicts.push({
      kind: "box_delete_vs_change",
      targetPath,
      id: base.id,
      message:
        `Box "${base.id}" was deleted in Max but changed in desired DSL`,
    });
    return undefined;
  }
  if (live && !desired) {
    if (equalBox(base, live)) return undefined;
    conflicts.push({
      kind: "box_change_vs_delete",
      targetPath,
      id: base.id,
      message:
        `Box "${base.id}" was changed in Max but deleted in desired DSL`,
    });
    return undefined;
  }

  const merged = mergeBoxFields(base, live!, desired!, targetPath, conflicts);
  const patcher = mergeOptionalNode(
    base.patcher,
    live!.patcher,
    desired!.patcher,
    [...targetPath, merged.varName],
    base.id,
    conflicts
  );
  return { ...merged, patcher };
}

function mergeBoxFields(
  base: PatchBox,
  live: PatchBox,
  desired: PatchBox,
  targetPath: readonly string[],
  conflicts: PatchMergeConflict[]
): Omit<PatchBox, "patcher"> {
  const merged = { ...base } as Record<PatchBoxField, unknown>;
  for (const field of BOX_FIELDS) {
    const baseValue = base[field];
    const liveValue = live[field];
    const desiredValue = desired[field];
    const liveChanged = !equalValue(baseValue, liveValue);
    const desiredChanged = !equalValue(baseValue, desiredValue);

    if (
      liveChanged &&
      desiredChanged &&
      !equalValue(liveValue, desiredValue)
    ) {
      conflicts.push({
        kind: "box_field",
        targetPath,
        id: base.id,
        field,
        message:
          `Box "${base.id}" field "${field}" was changed differently in ` +
          "Max and desired DSL",
      });
      continue;
    }
    merged[field] = desiredChanged ? desiredValue : liveValue;
  }

  const { patcher: _patcher, ...withoutPatcher } = merged as unknown as PatchBox;
  return withoutPatcher;
}

function mergeOptionalNode(
  base: PatchGraphNode | undefined,
  live: PatchGraphNode | undefined,
  desired: PatchGraphNode | undefined,
  targetPath: readonly string[],
  boxId: string,
  conflicts: PatchMergeConflict[]
): PatchGraphNode | undefined {
  if (!base) {
    if (!live) return desired;
    if (!desired) return live;
    if (equalNode(live, desired)) return live;
    conflicts.push({
      kind: "box_concurrent_add",
      targetPath,
      id: boxId,
      message: `Subpatcher "${boxId}" was added differently in Max and desired DSL`,
    });
    return undefined;
  }
  if (!live && !desired) return undefined;
  if (!live && desired) {
    if (equalNode(base, desired)) return undefined;
    conflicts.push({
      kind: "box_delete_vs_change",
      targetPath,
      id: boxId,
      message:
        `Subpatcher "${boxId}" was removed in Max but changed in desired DSL`,
    });
    return undefined;
  }
  if (live && !desired) {
    if (equalNode(base, live)) return undefined;
    conflicts.push({
      kind: "box_change_vs_delete",
      targetPath,
      id: boxId,
      message:
        `Subpatcher "${boxId}" was changed in Max but removed in desired DSL`,
    });
    return undefined;
  }
  return mergeNode(base, live!, desired!, targetPath, conflicts);
}

function mergeConnections(
  base: readonly PatchConnection[],
  live: readonly PatchConnection[],
  desired: readonly PatchConnection[]
): PatchConnection[] {
  const baseConnections = connectionsByKey(base);
  const liveConnections = connectionsByKey(live);
  const desiredConnections = connectionsByKey(desired);
  const keys = new Set([
    ...baseConnections.keys(),
    ...liveConnections.keys(),
    ...desiredConnections.keys(),
  ]);
  const result: PatchConnection[] = [];

  for (const key of [...keys].sort()) {
    const inBase = baseConnections.has(key);
    const inLive = liveConnections.has(key);
    const inDesired = desiredConnections.has(key);
    const include = inLive === inDesired
      ? inLive
      : inLive === inBase
        ? inDesired
        : inLive;
    if (!include) continue;
    result.push(
      liveConnections.get(key) ??
      desiredConnections.get(key) ??
      baseConnections.get(key)!
    );
  }
  return result;
}

function boxesById(boxes: readonly PatchBox[]): Map<string, PatchBox> {
  return new Map(boxes.map((box) => [box.id, box]));
}

function connectionsByKey(
  connections: readonly PatchConnection[]
): Map<string, PatchConnection> {
  return new Map(
    connections.map((connection) => [connectionKey(connection), connection])
  );
}

function connectionKey(connection: PatchConnection): string {
  return connectionLabel(connection);
}

function connectionLabel(connection: PatchConnection): string {
  return `${connection.source.id}[${connection.source.port}]->` +
    `${connection.destination.id}[${connection.destination.port}]`;
}

function equalBox(left: PatchBox, right: PatchBox): boolean {
  return equalValue(left, right);
}

function equalNode(left: PatchGraphNode, right: PatchGraphNode): boolean {
  return equalValue(left, right);
}

function equalValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, PatchValue | undefined>)[key];
      if (child !== undefined) result[key] = sortValue(child);
    }
    return result;
  }
  return value;
}

function sortConflicts(
  conflicts: readonly PatchMergeConflict[]
): readonly PatchMergeConflict[] {
  return [...conflicts].sort((left, right) =>
    conflictKey(left).localeCompare(conflictKey(right))
  );
}

function conflictKey(conflict: PatchMergeConflict): string {
  return [
    conflict.targetPath.join("/"),
    conflict.id ?? "",
    conflict.field ?? "",
    conflict.kind,
    conflict.message,
  ].join("\u0000");
}
