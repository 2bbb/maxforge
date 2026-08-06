import {
  CompileWarning,
  ObjectDatabase,
} from "../core/types.js";
import {
  compileDslToPatchGraph,
  createEmptyPatchGraph,
  diffPatchGraphs,
  PatchGraph,
  PatchPlan,
} from "../max/patch-graph.js";
import {
  PatchReconciliationConflict,
  reconcilePatchGraphs,
} from "./reconcile.js";
import {
  MaxforgeAppliedEvent,
  MaxforgePatcherSnapshot,
  MaxforgeSnapshotBox,
  MaxforgeSnapshotConnection,
  MaxforgeSnapshotEvent,
  PatchPlanTransport,
} from "./bridge.js";

export interface CompilePlanRequest {
  readonly patcherId: string;
  readonly desiredDsl: string;
  readonly scope: string;
  readonly currentDsl?: string;
}

export interface ApplyDslRequest extends CompilePlanRequest {
  readonly manualChanges?: "reject" | "merge";
}

export interface CompilePlanResult {
  readonly plan: PatchPlan;
  readonly desiredGraph: PatchGraph;
  readonly warnings: readonly CompileWarning[];
}

export interface ApplyDslResult {
  readonly plan: PatchPlan;
  readonly acknowledgement: MaxforgeAppliedEvent;
  readonly warnings: readonly CompileWarning[];
  readonly baselineCaptured: boolean;
  readonly baselineWarning?: string;
  readonly manualChangesMerged: number;
}

export interface ReconcilePlanResult {
  readonly canApply: boolean;
  readonly plan?: PatchPlan;
  readonly mergedGraph?: PatchGraph;
  readonly intentGraph: PatchGraph;
  readonly conflicts: readonly PatchReconciliationConflict[];
  readonly comparisonAvailable: boolean;
  readonly managedChangeCount: number;
  readonly unmanagedChangeCount: number;
  readonly warnings: readonly CompileWarning[];
}

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
        | "managed"
      )[];
      readonly before: MaxforgeSnapshotBox;
      readonly after: MaxforgeSnapshotBox;
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

export interface InspectPatchResult {
  readonly snapshot: MaxforgeSnapshotEvent;
  readonly comparisonAvailable: boolean;
  readonly changes: readonly PatchSnapshotChange[];
  readonly managedChangeCount: number;
  readonly unmanagedChangeCount: number;
}

export class MaxforgePatchService {
  private readonly managedGraphs = new Map<string, PatchGraph>();
  private readonly intentGraphs = new Map<string, PatchGraph>();
  private readonly baselineSnapshots =
    new Map<string, MaxforgePatcherSnapshot>();

  constructor(
    private readonly database: ObjectDatabase,
    private readonly transport: PatchPlanTransport
  ) {}

  compilePlan(request: CompilePlanRequest): CompilePlanResult {
    const desired = this.compileGraph(request.desiredDsl, request.scope);
    const current = this.resolveCurrentGraph(request);
    this.assertLiveRevision(request.patcherId, request.scope, current.graph);
    this.assertNoPreservedManualEdits(request, current.graph);
    return {
      plan: diffPatchGraphs(current.graph, desired.graph),
      desiredGraph: desired.graph,
      warnings: [...current.warnings, ...desired.warnings],
    };
  }

  async applyDsl(request: ApplyDslRequest): Promise<ApplyDslResult> {
    let plan: PatchPlan;
    let nextGraph: PatchGraph;
    let warnings: readonly CompileWarning[];
    let intentGraph: PatchGraph;
    let manualChangesMerged = 0;
    if (request.manualChanges === "merge") {
      const reconciliation = await this.reconcilePlan(request);
      if (
        !reconciliation.canApply ||
        !reconciliation.plan ||
        !reconciliation.mergedGraph
      ) {
        throw new PatchReconciliationError(reconciliation.conflicts);
      }
      plan = reconciliation.plan;
      nextGraph = reconciliation.mergedGraph;
      intentGraph = reconciliation.intentGraph;
      warnings = reconciliation.warnings;
      manualChangesMerged = reconciliation.managedChangeCount;
    } else {
      const desired = this.compileGraph(request.desiredDsl, request.scope);
      const current = this.resolveCurrentGraph(request);
      this.assertLiveRevision(request.patcherId, request.scope, current.graph);
      this.assertNoPreservedManualEdits(request, current.graph);
      await this.assertNoManagedDrift(request.patcherId, request.scope);
      plan = diffPatchGraphs(current.graph, desired.graph);
      nextGraph = desired.graph;
      intentGraph = desired.graph;
      warnings = [...current.warnings, ...desired.warnings];
    }

    const acknowledgement = await this.transport.apply(
      request.patcherId,
      plan
    );
    this.managedGraphs.set(
      targetKey(request.patcherId, request.scope),
      nextGraph
    );
    this.intentGraphs.set(
      targetKey(request.patcherId, request.scope),
      intentGraph
    );
    const baseline = await this.captureBaseline(
      request.patcherId,
      request.scope,
      acknowledgement.revision
    );

    return {
      plan,
      acknowledgement,
      warnings,
      baselineCaptured: baseline.captured,
      manualChangesMerged,
      ...(baseline.warning ? { baselineWarning: baseline.warning } : {}),
    };
  }

  async reconcilePlan(
    request: CompilePlanRequest
  ): Promise<ReconcilePlanResult> {
    const desired = this.compileGraph(request.desiredDsl, request.scope);
    const current = this.resolveCurrentGraph(request);
    this.assertLiveRevision(request.patcherId, request.scope, current.graph);
    const intent = request.currentDsl !== undefined
      ? current.graph
      : this.intentGraphs.get(targetKey(request.patcherId, request.scope)) ??
        current.graph;

    const key = targetKey(request.patcherId, request.scope);
    const baseline = this.baselineSnapshots.get(key);
    const snapshot = await this.transport.inspect(
      request.patcherId,
      request.scope
    );
    this.assertInspectionRevision(
      request.patcherId,
      request.scope,
      current.graph,
      snapshot
    );
    const reconciliation = reconcilePatchGraphs(
      current.graph,
      intent,
      desired.graph,
      snapshot.patcher,
      baseline
    );
    const changes = baseline
      ? diffPatcherSnapshots(baseline, snapshot.patcher)
      : [];
    const managedChangeCount = baseline
      ? changes.filter((change) => change.managed).length
      : diffPatchGraphs(current.graph, reconciliation.liveGraph).operations.length +
        reconciliation.conflicts.filter((conflict) =>
          conflict.kind === "managed_box_added" ||
          conflict.kind === "managed_identity_changed" ||
          conflict.kind === "duplicate_managed_identity"
        ).length;

    return {
      canApply:
        reconciliation.conflicts.length === 0 &&
        reconciliation.plan !== undefined &&
        reconciliation.graph !== undefined,
      plan: reconciliation.plan,
      mergedGraph: reconciliation.graph,
      intentGraph: desired.graph,
      conflicts: reconciliation.conflicts,
      comparisonAvailable: baseline !== undefined,
      managedChangeCount,
      unmanagedChangeCount: changes.filter((change) => !change.managed).length,
      warnings: [...current.warnings, ...desired.warnings],
    };
  }

  async inspectPatch(
    patcherId: string,
    scope: string
  ): Promise<InspectPatchResult> {
    const snapshot = await this.transport.inspect(patcherId, scope);
    const baseline = this.baselineSnapshots.get(targetKey(patcherId, scope));
    const changes = baseline
      ? diffPatcherSnapshots(baseline, snapshot.patcher)
      : [];
    return {
      snapshot,
      comparisonAvailable: baseline !== undefined,
      changes,
      managedChangeCount: changes.filter((change) => change.managed).length,
      unmanagedChangeCount: changes.filter((change) => !change.managed).length,
    };
  }

  getManagedRevisions(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.managedGraphs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, graph]) => [target, graph.revision])
    );
  }

  getBaselineScopes(): readonly string[] {
    return [...this.baselineSnapshots.keys()].sort();
  }

  private async assertNoManagedDrift(
    patcherId: string,
    scope: string
  ): Promise<void> {
    if (!this.baselineSnapshots.has(targetKey(patcherId, scope))) return;
    const inspection = await this.inspectPatch(patcherId, scope);
    if (inspection.managedChangeCount === 0) return;
    throw new Error(
      `Max patch "${patcherId}" scope "${scope}" has ` +
      `${inspection.managedChangeCount} managed ` +
      "manual change(s) since the last acknowledged apply. Inspect the live " +
      "patch and reconcile it before applying new DSL."
    );
  }

  private async captureBaseline(
    patcherId: string,
    scope: string,
    expectedRevision: string
  ): Promise<{
    captured: boolean;
    warning?: string;
  }> {
    const key = targetKey(patcherId, scope);
    try {
      const snapshot = await this.transport.inspect(patcherId, scope);
      if (snapshot.revision !== expectedRevision) {
        throw new Error(
          `inspection revision ${snapshot.revision ?? "uninitialized"} does ` +
          `not match acknowledged revision ${expectedRevision}`
        );
      }
      this.baselineSnapshots.set(key, snapshot.patcher);
      return { captured: true };
    } catch (error) {
      this.baselineSnapshots.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      return {
        captured: false,
        warning:
          "Max applied the patch, but maxforge could not capture the " +
          `post-apply inspection baseline: ${message}`,
      };
    }
  }

  private resolveCurrentGraph(request: CompilePlanRequest): {
    graph: PatchGraph;
    warnings: readonly CompileWarning[];
  } {
    if (request.currentDsl !== undefined) {
      return this.compileGraph(request.currentDsl, request.scope);
    }

    const managed = this.managedGraphs.get(
      targetKey(request.patcherId, request.scope)
    );
    if (managed) return { graph: managed, warnings: [] };

    const liveRevision = this.transport.getLiveRevision(
      request.patcherId,
      request.scope
    );
    if (typeof liveRevision === "string") {
      throw new Error(
        `Max patch "${request.patcherId}" scope "${request.scope}" is ` +
        `already initialized at revision ` +
        `${liveRevision}, but this MCP process has no graph state. Provide ` +
        "currentDsl once to seed the diff."
      );
    }

    return {
      graph: createEmptyPatchGraph(request.scope),
      warnings: [],
    };
  }

  private assertLiveRevision(
    patcherId: string,
    scope: string,
    current: PatchGraph
  ): void {
    const liveRevision = this.transport.getLiveRevision(patcherId, scope);
    if (liveRevision === undefined) return;

    const expectedRevision = liveRevision ?? createEmptyPatchGraph(scope).revision;
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Current DSL revision ${current.revision} does not match Max patch ` +
        `"${patcherId}" scope "${scope}" revision ` +
        `${liveRevision ?? "uninitialized"}`
      );
    }
  }

  private assertNoPreservedManualEdits(
    request: CompilePlanRequest,
    current: PatchGraph
  ): void {
    if (request.currentDsl !== undefined) return;
    const intent = this.intentGraphs.get(
      targetKey(request.patcherId, request.scope)
    );
    if (!intent || intent.revision === current.revision) return;
    throw new Error(
      `Max patch "${request.patcherId}" scope "${request.scope}" contains ` +
      "previously merged manual edits. Use maxforge_reconcile_patch and apply " +
      "with manualChanges set to merge, or provide a complete currentDsl that " +
      "includes the preserved edits."
    );
  }

  private assertInspectionRevision(
    patcherId: string,
    scope: string,
    current: PatchGraph,
    snapshot: MaxforgeSnapshotEvent
  ): void {
    const expected = snapshot.revision ?? createEmptyPatchGraph(scope).revision;
    if (current.revision !== expected) {
      throw new Error(
        `Inspection revision ${snapshot.revision ?? "uninitialized"} does not ` +
        `match current graph revision ${current.revision} for Max patch ` +
        `"${patcherId}" scope "${scope}"`
      );
    }
  }

  private compileGraph(
    source: string,
    scope: string
  ): { graph: PatchGraph; warnings: readonly CompileWarning[] } {
    const result = compileDslToPatchGraph(source, this.database, scope);
    if (!result.success || !result.graph) {
      const diagnostics = result.errors.map((error) => {
        const location = error.line ? `Line ${error.line}: ` : "";
        return `${location}[${error.code}] ${error.message}`;
      });
      throw new Error(diagnostics.join("\n") || "DSL compilation failed");
    }
    return {
      graph: result.graph,
      warnings: result.warnings,
    };
  }
}

export class PatchReconciliationError extends Error {
  constructor(
    readonly conflicts: readonly PatchReconciliationConflict[]
  ) {
    super(
      "Cannot merge live Max edits with desired DSL:\n" +
      conflicts.map((conflict) => `- ${conflict.message}`).join("\n")
    );
    this.name = "PatchReconciliationError";
  }
}

function targetKey(patcherId: string, scope: string): string {
  return `${patcherId}:${scope}`;
}

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
    if (!currentConnections.has(key)) {
      changes.push({
        kind: "connection_removed",
        managed: connectionTouchesManagedBox(
          connection,
          baselineManagedBoxes
        ),
        connection,
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
  "varName" | "maxclass" | "patchingRect" | "text" | "managed"
> {
  const fields: Array<
    "varName" | "maxclass" | "patchingRect" | "text" | "managed"
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
  return `${change.kind}\u0000${snapshotConnectionKey(change.connection)}`;
}

function pathKey(path: readonly string[]): string {
  return path.join("/");
}
