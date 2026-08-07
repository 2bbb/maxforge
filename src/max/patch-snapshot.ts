import type {
  MaxforgePatcherSnapshot,
  MaxforgeSnapshotBox,
  MaxforgeSnapshotConnection,
} from "./patch-protocol.js";

export type PatchSnapshotChange =
  | {
      readonly kind: "box_added";
      readonly managed: boolean;
      readonly box: MaxforgeSnapshotBox;
    }
  | {
      readonly kind: "box_removed";
      readonly managed: boolean;
      readonly box: MaxforgeSnapshotBox;
    }
  | {
      readonly kind: "box_changed";
      readonly managed: boolean;
      readonly fields: readonly (
        | "varName"
        | "maxclass"
        | "patchingRect"
        | "text"
        | "comment"
        | "attributes"
        | "managed"
      )[];
      readonly before: MaxforgeSnapshotBox;
      readonly after: MaxforgeSnapshotBox;
    }
  | {
      readonly kind: "connection_changed";
      readonly managed: boolean;
      readonly fields: readonly "attributes"[];
      readonly before: MaxforgeSnapshotConnection;
      readonly after: MaxforgeSnapshotConnection;
    }
  | {
      readonly kind: "connection_added";
      readonly managed: boolean;
      readonly connection: MaxforgeSnapshotConnection;
    }
  | {
      readonly kind: "connection_removed";
      readonly managed: boolean;
      readonly connection: MaxforgeSnapshotConnection;
    };

export function diffPatcherSnapshots(
  baseline: MaxforgePatcherSnapshot,
  current: MaxforgePatcherSnapshot
): readonly PatchSnapshotChange[] {
  const changes: PatchSnapshotChange[] = [];
  const baselineBoxes = new Map(
    baseline.boxes.map((box) => [snapshotBoxKey(box), box])
  );
  const currentBoxes = new Map(
    current.boxes.map((box) => [snapshotBoxKey(box), box])
  );

  for (const [key, box] of baselineBoxes) {
    const currentBox = currentBoxes.get(key);
    if (!currentBox) {
      changes.push({ kind: "box_removed", managed: box.managed, box });
      continue;
    }
    const fields = changedBoxFields(box, currentBox);
    if (fields.length > 0) {
      changes.push({
        kind: "box_changed",
        managed: box.managed || currentBox.managed,
        fields,
        before: box,
        after: currentBox,
      });
    }
  }
  for (const [key, box] of currentBoxes) {
    if (!baselineBoxes.has(key)) {
      changes.push({ kind: "box_added", managed: box.managed, box });
    }
  }

  const baselineConnections = new Map(
    baseline.connections.map((connection) => [
      snapshotConnectionKey(connection),
      connection,
    ])
  );
  const currentConnections = new Map(
    current.connections.map((connection) => [
      snapshotConnectionKey(connection),
      connection,
    ])
  );
  const baselineManagedBoxes = managedBoxKeys(baseline);
  const currentManagedBoxes = managedBoxKeys(current);

  for (const [key, connection] of baselineConnections) {
    const currentConnection = currentConnections.get(key);
    if (!currentConnection) {
      changes.push({
        kind: "connection_removed",
        managed: connectionTouchesManagedBox(
          connection,
          baselineManagedBoxes
        ),
        connection,
      });
    } else if (!sameSnapshotAttributes(
      connection.attributes,
      currentConnection.attributes
    )) {
      changes.push({
        kind: "connection_changed",
        managed: connectionTouchesManagedBox(
          connection,
          baselineManagedBoxes
        ) || connectionTouchesManagedBox(
          currentConnection,
          currentManagedBoxes
        ),
        fields: ["attributes"],
        before: connection,
        after: currentConnection,
      });
    }
  }
  for (const [key, connection] of currentConnections) {
    if (!baselineConnections.has(key)) {
      changes.push({
        kind: "connection_added",
        managed: connectionTouchesManagedBox(
          connection,
          currentManagedBoxes
        ),
        connection,
      });
    }
  }

  return changes.sort((left, right) =>
    snapshotChangeKey(left).localeCompare(snapshotChangeKey(right))
  );
}

function snapshotBoxKey(box: MaxforgeSnapshotBox): string {
  return `${pathKey(box.targetPath)}\u0000${box.runtimeId}`;
}

function changedBoxFields(
  baseline: MaxforgeSnapshotBox,
  current: MaxforgeSnapshotBox
): Array<
  | "varName"
  | "maxclass"
  | "patchingRect"
  | "text"
  | "comment"
  | "attributes"
  | "managed"
> {
  const fields: Array<
    | "varName"
    | "maxclass"
    | "patchingRect"
    | "text"
    | "comment"
    | "attributes"
    | "managed"
  > = [];
  if (baseline.varName !== current.varName) fields.push("varName");
  if (baseline.maxclass !== current.maxclass) fields.push("maxclass");
  if (
    baseline.patchingRect.some(
      (value, index) => value !== current.patchingRect[index]
    )
  ) {
    fields.push("patchingRect");
  }
  if (baseline.text !== current.text) fields.push("text");
  if (baseline.comment !== current.comment) fields.push("comment");
  if (!sameSnapshotAttributes(baseline.attributes, current.attributes)) {
    fields.push("attributes");
  }
  if (baseline.managed !== current.managed) fields.push("managed");
  return fields;
}

function snapshotConnectionKey(
  connection: MaxforgeSnapshotConnection
): string {
  return [
    pathKey(connection.targetPath),
    connection.source.runtimeId,
    connection.source.port,
    connection.destination.runtimeId,
    connection.destination.port,
  ].join("\u0000");
}

function managedBoxKeys(snapshot: MaxforgePatcherSnapshot): ReadonlySet<string> {
  return new Set(
    snapshot.boxes
      .filter((box) => box.managed)
      .map((box) => snapshotBoxKey(box))
  );
}

function connectionTouchesManagedBox(
  connection: MaxforgeSnapshotConnection,
  managedBoxes: ReadonlySet<string>
): boolean {
  const path = pathKey(connection.targetPath);
  return managedBoxes.has(`${path}\u0000${connection.source.runtimeId}`) ||
    managedBoxes.has(`${path}\u0000${connection.destination.runtimeId}`);
}

function snapshotChangeKey(change: PatchSnapshotChange): string {
  if (change.kind === "box_added" || change.kind === "box_removed") {
    return `${change.kind}\u0000${snapshotBoxKey(change.box)}`;
  }
  if (change.kind === "box_changed") {
    return `${change.kind}\u0000${snapshotBoxKey(change.after)}`;
  }
  if (change.kind === "connection_changed") {
    return `${change.kind}\u0000${snapshotConnectionKey(change.after)}`;
  }
  return `${change.kind}\u0000${snapshotConnectionKey(change.connection)}`;
}

function sameSnapshotAttributes(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>
): boolean {
  return JSON.stringify(sortSnapshotAttributes(left)) ===
    JSON.stringify(sortSnapshotAttributes(right));
}

function sortSnapshotAttributes(
  attributes: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right))
  );
}

function pathKey(path: readonly string[]): string {
  return path.join("/");
}
