import { performance } from "node:perf_hooks";
import type { CompileWarning } from "../core/types.js";
import {
  createEmptyPatchGraph,
  diffPatchGraphs,
  PatchGraph,
  PatchPlan,
} from "../max/patch-graph.js";
import {
  PatchReconciliationConflict,
  reconcilePatchGraphs,
  reconstructManagedGraph,
} from "./reconcile.js";
import {
  EraseMaxforgeProjectHistoryRequest,
  EraseMaxforgeProjectHistoryResult,
  MaxforgeAppliedEvent,
  MaxforgeEditObservationCause,
  MaxforgeEditHistoryPersistence,
  MaxforgePatchMetadata,
  MaxforgePatchHistoryIdentityStatus,
  MaxforgePatcherSnapshot,
  MaxforgeSnapshotEvent,
  PatchPlanTransport,
  ResolveMaxforgePatchHistoryIdentityRequest,
  ResolveMaxforgePatchHistoryIdentityResult,
} from "../max/patch-protocol.js";
import {
  diffPatcherSnapshots,
  type PatchSnapshotChange,
} from "../max/patch-snapshot.js";
import {
  reviewPatchEdits,
  type PatchEditReview,
} from "../max/patch-edit-review.js";
import {
  PatchStateStore,
  PendingPatchApply,
} from "./state-store.js";
import type { PatchGraphAdapter } from "./patch-adapter.js";
import type { EditHistoryStore } from "./edit-history-store.js";

export interface ApplyDslTimings {
  readonly preflightMs: number;
  readonly pendingStatePersistenceMs: number;
  readonly nativeApplyMs: number;
  readonly postApplyInspectionMs: number;
  readonly finalStatePersistenceMs: number;
  readonly totalMs: number;
}

export interface CompilePlanRequest {
  readonly patcherId: string;
  readonly desiredDsl: string;
  readonly scope: string;
  readonly currentDsl?: string;
}

export interface ApplyDslRequest extends CompilePlanRequest {
  readonly manualChanges?: "reject" | "merge";
  readonly expectedStructureToken?: string;
}

export interface PostApplyVerification {
  readonly revision: string;
  readonly structureToken: string;
  readonly boxCount: number;
  readonly connectionCount: number;
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
  readonly verification?: PostApplyVerification;
  readonly manualChangesMerged: number;
  readonly statePersisted: boolean;
  readonly stateWarning?: string;
  readonly workingDsl: string;
  readonly workingDslRequiredAsCurrent: boolean;
  readonly timings: ApplyDslTimings;
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
  readonly structureToken: string;
}

export interface InspectPatchResult {
  readonly snapshot: MaxforgeSnapshotEvent;
  readonly comparisonAvailable: boolean;
  readonly changes: readonly PatchSnapshotChange[];
  readonly managedChangeCount: number;
  readonly unmanagedChangeCount: number;
}

export type EditObservationComparisonBasis =
  | "session_baseline"
  | "previous_observation"
  | "incomplete_after_drop"
  | "unavailable";

export interface LiveEditHistoryEntry {
  readonly sequence: number;
  readonly sessionSequence: number;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly sessionStartedAt: string;
  readonly observedAt: string;
  readonly causes: readonly MaxforgeEditObservationCause[];
  readonly structureToken: string;
  readonly comparisonBasis: EditObservationComparisonBasis;
  readonly changes: readonly PatchSnapshotChange[];
  readonly review: PatchEditReview;
}

export interface LiveEditHistoryResult {
  readonly patcherId: string;
  readonly scope: string;
  readonly supported: boolean;
  readonly droppedEvents: number;
  readonly persistence: MaxforgeEditHistoryPersistence;
  readonly identity: MaxforgePatchHistoryIdentityStatus | null;
  readonly patchMetadata: readonly MaxforgePatchMetadata[];
  readonly latestSequence: number | null;
  readonly observations: readonly LiveEditHistoryEntry[];
  readonly limitations: readonly string[];
}

export interface ReviewLiveChangesResult extends InspectPatchResult {
  readonly review: PatchEditReview;
  readonly structureToken: string;
  readonly acknowledgedRevision?: string;
  readonly observedManagedRevision?: string;
  readonly canAdopt: boolean;
  readonly adoptionBlockedReason?: string;
  readonly conflicts: readonly PatchReconciliationConflict[];
  readonly proposedWorkingDsl?: string;
}

export interface AdoptLiveChangesRequest {
  readonly patcherId: string;
  readonly scope: string;
  readonly expectedStructureToken: string;
}

export interface AdoptLiveChangesResult extends ReviewLiveChangesResult {
  readonly previousRevision: string;
  readonly adoptedRevision: string;
  readonly revisionAdvanced: boolean;
  readonly acknowledgement?: MaxforgeAppliedEvent;
  readonly statePersisted: boolean;
  readonly stateWarning?: string;
  readonly workingDsl: string;
}

export type PendingApplyLiveState = "base" | "target" | "other";

export interface PendingApplyInspection {
  readonly patcherId: string;
  readonly scope: string;
  readonly baseRevision: string;
  readonly targetRevision: string;
  readonly intentRevision: string;
  readonly liveRevision: string;
  readonly liveState: PendingApplyLiveState;
  readonly structureToken: string;
  readonly snapshot: MaxforgeSnapshotEvent;
  readonly comparisonAvailable: boolean;
  readonly changes: readonly PatchSnapshotChange[];
  readonly managedChangeCount: number;
  readonly unmanagedChangeCount: number;
  readonly review: PatchEditReview;
  readonly baseWorkingDsl?: string;
  readonly targetWorkingDsl: string;
  readonly intentWorkingDsl: string;
  readonly supersededApply?: {
    readonly baseRevision: string;
    readonly targetRevision: string;
    readonly intentRevision: string;
    readonly targetWorkingDsl: string;
    readonly intentWorkingDsl: string;
  };
}

export interface RecoverPendingApplyRequest {
  readonly patcherId: string;
  readonly scope: string;
  readonly action: "rebase_live";
  readonly expectedLiveRevision: string;
  readonly expectedStructureToken: string;
  readonly currentDsl: string;
}

export interface RecoverPendingApplyResult extends PendingApplyInspection {
  readonly action: "rebase_live";
  readonly previousLiveRevision: string;
  readonly managedRevision: string;
  readonly revisionAdvanced: boolean;
  readonly acknowledgement?: MaxforgeAppliedEvent;
  readonly statePersisted: boolean;
  readonly stateWarning?: string;
  readonly workingDsl: string;
}

export class MaxforgePatchService {
  private readonly managedGraphs: Map<string, PatchGraph>;
  private readonly intentGraphs: Map<string, PatchGraph>;
  private readonly workingSources: Map<string, string>;
  private readonly intentSources: Map<string, string>;
  private readonly baselineSnapshots: Map<string, MaxforgePatcherSnapshot>;
  private readonly pendingApplies: Map<string, PendingPatchApply>;
  private readonly latestInspections = new Map<string, MaxforgeSnapshotEvent>();

  constructor(
    private readonly patchAdapter: PatchGraphAdapter,
    private readonly transport: PatchPlanTransport,
    private readonly stateStore?: PatchStateStore,
    private readonly editHistoryStore?: EditHistoryStore
  ) {
    const state = stateStore?.load();
    this.managedGraphs = new Map(state?.managedGraphs);
    this.intentGraphs = new Map(state?.intentGraphs);
    this.workingSources = new Map(state?.workingSources);
    this.intentSources = new Map(state?.intentSources);
    this.baselineSnapshots = new Map(state?.baselineSnapshots);
    this.pendingApplies = new Map(state?.pendingApplies);
  }

  compilePlan(request: CompilePlanRequest): CompilePlanResult {
    const desired = this.patchAdapter.compile(request.desiredDsl, request.scope);
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
    const totalStartedAt = performance.now();
    let plan: PatchPlan;
    let nextGraph: PatchGraph;
    let warnings: readonly CompileWarning[];
    let intentGraph: PatchGraph;
    let manualChangesMerged = 0;
    if (request.manualChanges === "merge") {
      const reconciliation = await this.reconcilePlan(
        request,
        request.expectedStructureToken
      );
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
      const desired = this.patchAdapter.compile(request.desiredDsl, request.scope);
      const current = this.resolveCurrentGraph(request);
      this.assertLiveRevision(request.patcherId, request.scope, current.graph);
      this.assertNoPreservedManualEdits(request, current.graph);
      const baseStructureToken = await this.assertNoManagedDrift(
        request.patcherId,
        request.scope,
        current.graph,
        request.expectedStructureToken
      );
      plan = {
        ...diffPatchGraphs(current.graph, desired.graph),
        baseStructureToken,
      };
      nextGraph = desired.graph;
      intentGraph = desired.graph;
      warnings = [...current.warnings, ...desired.warnings];
    }

    const workingDslRequiredAsCurrent =
      nextGraph.revision !== intentGraph.revision;
    const workingDsl = workingDslRequiredAsCurrent
      ? this.patchAdapter.serialize(nextGraph)
      : request.desiredDsl;
    const intentDsl = request.desiredDsl;
    const key = targetKey(request.patcherId, request.scope);
    this.pendingApplies.set(key, {
      baseRevision: plan.baseRevision,
      nextGraph,
      intentGraph,
      nextSource: workingDsl,
      intentSource: intentDsl,
    });
    const pendingStatePersistenceStartedAt = performance.now();
    const preflightMs = elapsedMilliseconds(
      totalStartedAt,
      pendingStatePersistenceStartedAt
    );
    this.persistState();

    const nativeApplyStartedAt = performance.now();
    const pendingStatePersistenceMs = elapsedMilliseconds(
      pendingStatePersistenceStartedAt,
      nativeApplyStartedAt
    );
    const acknowledgement = await this.transport.apply(request.patcherId, plan);
    this.managedGraphs.set(
      key,
      nextGraph
    );
    this.intentGraphs.set(
      key,
      intentGraph
    );
    this.workingSources.set(key, workingDsl);
    this.intentSources.set(key, intentDsl);
    this.pendingApplies.delete(key);
    const postApplyInspectionStartedAt = performance.now();
    const nativeApplyMs = elapsedMilliseconds(
      nativeApplyStartedAt,
      postApplyInspectionStartedAt
    );
    const baseline = await this.captureBaseline(
      request.patcherId,
      request.scope,
      nextGraph
    );
    const finalStatePersistenceStartedAt = performance.now();
    const postApplyInspectionMs = elapsedMilliseconds(
      postApplyInspectionStartedAt,
      finalStatePersistenceStartedAt
    );
    const persistence = this.tryPersistState();
    const completedAt = performance.now();

    return {
      plan,
      acknowledgement,
      warnings,
      baselineCaptured: baseline.captured,
      ...(baseline.verification ? { verification: baseline.verification } : {}),
      manualChangesMerged,
      statePersisted: persistence.persisted,
      workingDsl,
      workingDslRequiredAsCurrent,
      ...(baseline.warning ? { baselineWarning: baseline.warning } : {}),
      ...(persistence.warning ? { stateWarning: persistence.warning } : {}),
      timings: {
        preflightMs,
        pendingStatePersistenceMs,
        nativeApplyMs,
        postApplyInspectionMs,
        finalStatePersistenceMs: elapsedMilliseconds(
          finalStatePersistenceStartedAt,
          completedAt
        ),
        totalMs: elapsedMilliseconds(totalStartedAt, completedAt),
      },
    };
  }

  async reconcilePlan(
    request: CompilePlanRequest,
    expectedStructureToken?: string
  ): Promise<ReconcilePlanResult> {
    const desired = this.patchAdapter.compile(request.desiredDsl, request.scope);
    const current = this.resolveCurrentGraph(request);
    this.assertLiveRevision(request.patcherId, request.scope, current.graph);
    const intent = request.currentDsl !== undefined
      ? current.graph
      : this.intentGraphs.get(targetKey(request.patcherId, request.scope)) ??
        current.graph;

    const key = targetKey(request.patcherId, request.scope);
    const baseline = this.baselineSnapshots.get(key);
    const snapshot = await this.inspectOrReuse(
      request.patcherId,
      request.scope,
      expectedStructureToken
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
      baseline,
      (box, baseBox) => this.patchAdapter.resolveLiveBox(box, baseBox)
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
    const conflicts: PatchReconciliationConflict[] = [
      ...reconciliation.conflicts,
    ];
    if (conflicts.length === 0 && reconciliation.graph) {
      try {
        this.patchAdapter.serialize(reconciliation.graph);
      } catch (error) {
        conflicts.push({
          kind: "unrepresentable_graph",
          targetPath: [],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const plan = reconciliation.plan && conflicts.length === 0
      ? {
          ...reconciliation.plan,
          baseStructureToken: snapshot.structureToken,
        }
      : undefined;

    return {
      canApply:
        conflicts.length === 0 &&
        plan !== undefined &&
        reconciliation.graph !== undefined,
      plan,
      mergedGraph: reconciliation.graph,
      intentGraph: desired.graph,
      conflicts,
      comparisonAvailable: baseline !== undefined,
      managedChangeCount,
      unmanagedChangeCount: changes.filter((change) => !change.managed).length,
      warnings: [...current.warnings, ...desired.warnings],
      structureToken: snapshot.structureToken,
    };
  }

  async inspectPatch(
    patcherId: string,
    scope: string
  ): Promise<InspectPatchResult> {
    const snapshot = await this.transport.inspect(patcherId, scope);
    this.latestInspections.set(targetKey(patcherId, scope), snapshot);
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

  getLiveEditHistory(
    patcherId: string,
    scope: string,
    afterSequence = 0
  ): LiveEditHistoryResult {
    const history = this.transport.getEditObservationHistory(patcherId, scope);
    let previous: MaxforgePatcherSnapshot | undefined;
    let previousSessionId: string | undefined;
    const observations = history.observations.map((observation) => {
      const startsSession = observation.sessionId !== previousSessionId;
      if (startsSession) previous = observation.sessionBaseline.patcher;
      const changes = previous
        ? diffPatcherSnapshots(previous, observation.event.patcher)
        : [];
      const comparisonBasis: EditObservationComparisonBasis = startsSession
        ? 1 < observation.sessionSequence
          ? "incomplete_after_drop"
          : "session_baseline"
        : "previous_observation";
      previous = observation.event.patcher;
      previousSessionId = observation.sessionId;
      return {
        sequence: observation.sequence,
        sessionSequence: observation.sessionSequence,
        sessionId: observation.sessionId,
        instanceId: observation.instanceId,
        sessionStartedAt: observation.sessionStartedAt,
        observedAt: observation.observedAt,
        causes: observation.event.causes,
        structureToken: observation.event.structureToken,
        comparisonBasis,
        changes,
        review: reviewPatchEdits(changes, scope),
      };
    });
    const latestSequence = observations.at(-1)?.sequence ?? null;
    return {
      patcherId,
      scope,
      supported: history.supported,
      droppedEvents: history.droppedEvents,
      persistence: history.persistence,
      identity: history.identity,
      patchMetadata: history.patchMetadata,
      latestSequence,
      observations: observations.filter(
        (observation) => afterSequence < observation.sequence
      ),
      limitations: [
        "Observations are debounced structural snapshots, not Max undo actions or proof of human intent.",
        "Each session starts from the snapshot sent during registration; observedAt is snapshot arrival time, not an edit-action timestamp.",
        "History is bounded; incomplete_after_drop means one or more earlier observations from that session are unavailable.",
        "Identity rekey or merge decisions affect history lookup only; they do not rewrite Max routing or original NDJSON evidence.",
      ],
    };
  }

  getPatchHistoryIdentity(
    patcherId: string,
    scope: string
  ): MaxforgePatchHistoryIdentityStatus {
    return this.requireEditHistoryStore().patchIdentity(patcherId, scope);
  }

  resolvePatchHistoryIdentity(
    request: ResolveMaxforgePatchHistoryIdentityRequest
  ): ResolveMaxforgePatchHistoryIdentityResult {
    const store = this.requireEditHistoryStore();
    const connectedSource = this.transport.listPatches().find((patch) =>
      store.matchesPatchIdentity(
        patch.patcherId,
        patch.scope,
        request.source.patcherId,
        request.source.scope
      )
    );
    if (connectedSource) {
      throw new Error(
        `Cannot ${request.action} patch history identity while source group ` +
        `${connectedSource.patcherId}:${connectedSource.scope} is connected. ` +
        "Close it first; this operation does not rewrite live maxforge.sync routing."
      );
    }
    return store.resolvePatchIdentity(request);
  }

  eraseProjectHistory(
    request: EraseMaxforgeProjectHistoryRequest
  ): EraseMaxforgeProjectHistoryResult {
    const store = this.requireEditHistoryStore();
    const status = this.transport.getStatus();
    if (status.connectedClients > 0 || status.registeredPatches.length > 0) {
      throw new Error(
        "Cannot erase project history while any Max WebSocket client is connected. " +
        "Close every maxforge.sync patch first."
      );
    }
    const erased = store.eraseProjectHistory(
      request.expectedProjectId,
      request.confirmation
    );
    const retainedObservationsCleared =
      this.transport.clearEditObservationHistory();
    return {
      ...erased,
      retainedObservationsCleared,
      physicalDataDeleted: erased.filesDeleted > 0,
      secureOverwriteGuaranteed: false,
    };
  }

  async reviewLiveChanges(
    patcherId: string,
    scope: string
  ): Promise<ReviewLiveChangesResult> {
    const key = targetKey(patcherId, scope);
    this.resolvePendingApply(key);
    const snapshot = await this.transport.inspect(patcherId, scope);
    const baseline = this.baselineSnapshots.get(key);
    const acknowledged = this.managedGraphs.get(key);
    const changes = baseline
      ? diffPatcherSnapshots(baseline, snapshot.patcher)
      : [];
    const base = {
      snapshot,
      comparisonAvailable: baseline !== undefined,
      changes,
      managedChangeCount: changes.filter((change) => change.managed).length,
      unmanagedChangeCount: changes.filter((change) => !change.managed).length,
      review: reviewPatchEdits(changes, scope),
      structureToken: snapshot.structureToken,
    };

    if (!acknowledged) {
      return {
        ...base,
        canAdopt: false,
        conflicts: [],
        adoptionBlockedReason:
          "No acknowledged managed graph exists for this patch and scope.",
      };
    }
    this.assertInspectionRevision(patcherId, scope, acknowledged, snapshot);
    if (!baseline) {
      return {
        ...base,
        acknowledgedRevision: acknowledged.revision,
        canAdopt: false,
        conflicts: [],
        adoptionBlockedReason:
          "No comparison baseline exists. Apply or recover the managed state before adopting live edits.",
      };
    }

    const observed = reconstructManagedGraph(
      acknowledged,
      snapshot.patcher,
      baseline,
      (box, baseBox, baselineBox) =>
        this.patchAdapter.resolveLiveBox(box, baseBox, baselineBox)
    );
    const representationIssue = adoptionRepresentationIssue(changes);
    let proposedWorkingDsl: string | undefined;
    let serializationIssue: string | undefined;
    if (observed.conflicts.length === 0 && !representationIssue) {
      try {
        proposedWorkingDsl = this.patchAdapter.serialize(observed.graph);
      } catch (error) {
        serializationIssue = error instanceof Error
          ? error.message
          : String(error);
      }
    }
    const adoptionBlockedReason = observed.conflicts.length > 0
      ? "Live edits cannot be reconstructed as a safe managed graph. " +
        "Resolve every reported conflict before adoption."
      : representationIssue ?? serializationIssue;
    return {
      ...base,
      acknowledgedRevision: acknowledged.revision,
      observedManagedRevision: observed.graph.revision,
      canAdopt:
        observed.conflicts.length === 0 &&
        adoptionBlockedReason === undefined &&
        proposedWorkingDsl !== undefined,
      conflicts: observed.conflicts,
      ...(proposedWorkingDsl ? { proposedWorkingDsl } : {}),
      ...(adoptionBlockedReason ? { adoptionBlockedReason } : {}),
    };
  }

  async adoptLiveChanges(
    request: AdoptLiveChangesRequest
  ): Promise<AdoptLiveChangesResult> {
    const { patcherId, scope, expectedStructureToken } = request;
    const key = targetKey(patcherId, scope);
    this.resolvePendingApply(key);
    const acknowledged = this.managedGraphs.get(key);
    if (!acknowledged) {
      throw new Error(
        `Max patch "${patcherId}" scope "${scope}" has no acknowledged managed graph to update`
      );
    }
    const baseline = this.baselineSnapshots.get(key);
    if (!baseline) {
      throw new Error(
        `Max patch "${patcherId}" scope "${scope}" has no comparison baseline; inspect and recover managed state before adopting live edits`
      );
    }

    const snapshot = await this.transport.inspect(patcherId, scope);
    this.assertInspectionRevision(patcherId, scope, acknowledged, snapshot);
    if (snapshot.structureToken !== expectedStructureToken) {
      throw new Error(
        `Max patch "${patcherId}" changed after review: expected structure token ` +
        `${expectedStructureToken}, received ${snapshot.structureToken}. Review live changes again.`
      );
    }

    const changes = diffPatcherSnapshots(baseline, snapshot.patcher);
    const representationIssue = adoptionRepresentationIssue(changes);
    if (representationIssue) throw new Error(representationIssue);
    const observed = reconstructManagedGraph(
      acknowledged,
      snapshot.patcher,
      baseline,
      (box, baseBox, baselineBox) =>
        this.patchAdapter.resolveLiveBox(box, baseBox, baselineBox)
    );
    if (observed.conflicts.length > 0) {
      throw new PatchReconciliationError(observed.conflicts);
    }
    const workingDsl = this.patchAdapter.serialize(observed.graph);

    const revisionAdvanced = acknowledged.revision !== observed.graph.revision;
    let acknowledgement: MaxforgeAppliedEvent | undefined;
    if (revisionAdvanced) {
      const plan: PatchPlan = {
        protocolVersion: 1,
        scope,
        baseRevision: acknowledged.revision,
        targetRevision: observed.graph.revision,
        baseStructureToken: snapshot.structureToken,
        operations: [],
        rollbackOperations: [],
      };
      this.pendingApplies.set(key, {
        baseRevision: acknowledged.revision,
        nextGraph: observed.graph,
        intentGraph: observed.graph,
        nextSource: workingDsl,
        intentSource: workingDsl,
      });
      this.persistState();
      acknowledgement = await this.transport.apply(patcherId, plan);
    }

    this.managedGraphs.set(key, observed.graph);
    this.intentGraphs.set(key, observed.graph);
    this.workingSources.set(key, workingDsl);
    this.intentSources.set(key, workingDsl);
    this.baselineSnapshots.set(key, snapshot.patcher);
    this.pendingApplies.delete(key);
    const persistence = this.tryPersistState();
    return {
      snapshot,
      comparisonAvailable: true,
      changes,
      managedChangeCount: changes.filter((change) => change.managed).length,
      unmanagedChangeCount: changes.filter((change) => !change.managed).length,
      review: reviewPatchEdits(changes, scope),
      structureToken: snapshot.structureToken,
      acknowledgedRevision: acknowledged.revision,
      observedManagedRevision: observed.graph.revision,
      canAdopt: true,
      conflicts: [],
      proposedWorkingDsl: workingDsl,
      previousRevision: acknowledged.revision,
      adoptedRevision: observed.graph.revision,
      revisionAdvanced,
      ...(acknowledgement ? { acknowledgement } : {}),
      statePersisted: persistence.persisted,
      workingDsl,
      ...(persistence.warning ? { stateWarning: persistence.warning } : {}),
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

  getWorkingSources(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.workingSources.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
    );
  }

  getStateStatus(): {
    readonly persistence: string | null;
    readonly pendingScopes: readonly string[];
  } {
    return {
      persistence: this.stateStore?.description ?? null,
      pendingScopes: [...this.pendingApplies.keys()].sort(),
    };
  }

  async inspectPendingApply(
    patcherId: string,
    scope: string
  ): Promise<PendingApplyInspection> {
    const key = targetKey(patcherId, scope);
    const pending = this.pendingApplies.get(key);
    if (!pending) {
      throw new Error(
        `Max patch "${patcherId}" scope "${scope}" has no pending apply`
      );
    }
    const liveRevision = this.transport.getLiveRevision(patcherId, scope);
    if (liveRevision === undefined) {
      throw new Error(
        `Pending apply for Max patch "${patcherId}" scope "${scope}" cannot ` +
        "be inspected until that patch is connected"
      );
    }
    if (liveRevision === null) {
      throw new Error(
        `Pending apply for Max patch "${patcherId}" scope "${scope}" reports ` +
        "an uninitialized live revision; reconnect and inspect before recovery"
      );
    }

    const snapshot = await this.transport.inspect(patcherId, scope);
    if (snapshot.revision !== liveRevision) {
      throw new Error(
        `Live revision changed during pending-apply inspection for Max patch ` +
        `"${patcherId}" scope "${scope}": status reported ${liveRevision}, ` +
        `inspection reported ${snapshot.revision ?? "uninitialized"}`
      );
    }
    const baseline = this.baselineSnapshots.get(key);
    const changes = baseline
      ? diffPatcherSnapshots(baseline, snapshot.patcher)
      : [];
    const baseGraph = pending.recoveryBaseGraph ?? this.managedGraphs.get(key);
    return {
      patcherId,
      scope,
      baseRevision: pending.baseRevision,
      targetRevision: pending.nextGraph.revision,
      intentRevision: pending.intentGraph.revision,
      liveRevision,
      liveState: liveRevision === pending.baseRevision
        ? "base"
        : liveRevision === pending.nextGraph.revision
          ? "target"
          : "other",
      structureToken: snapshot.structureToken,
      snapshot,
      comparisonAvailable: baseline !== undefined,
      changes,
      managedChangeCount: changes.filter((change) => change.managed).length,
      unmanagedChangeCount: changes.filter((change) => !change.managed).length,
      review: reviewPatchEdits(changes, scope),
      ...(baseGraph
        ? {
            baseWorkingDsl:
              pending.recoveryBaseSource ??
              this.workingSources.get(key) ??
              this.patchAdapter.serialize(baseGraph),
          }
        : {}),
      targetWorkingDsl: pending.nextSource,
      intentWorkingDsl: pending.intentSource,
      ...(pending.superseded
        ? {
            supersededApply: {
              baseRevision: pending.superseded.baseRevision,
              targetRevision: pending.superseded.nextGraph.revision,
              intentRevision: pending.superseded.intentGraph.revision,
              targetWorkingDsl: pending.superseded.nextSource,
              intentWorkingDsl: pending.superseded.intentSource,
            },
          }
        : {}),
    };
  }

  async recoverPendingApply(
    request: RecoverPendingApplyRequest
  ): Promise<RecoverPendingApplyResult> {
    const inspection = await this.inspectPendingApply(
      request.patcherId,
      request.scope
    );
    if (inspection.liveRevision !== request.expectedLiveRevision) {
      throw new Error(
        `Pending apply live revision changed after inspection: expected ` +
        `${request.expectedLiveRevision}, received ${inspection.liveRevision}`
      );
    }
    if (inspection.structureToken !== request.expectedStructureToken) {
      throw new Error(
        `Max patch "${request.patcherId}" changed after pending-apply ` +
        `inspection: expected structure token ${request.expectedStructureToken}, ` +
        `received ${inspection.structureToken}. Inspect the pending apply again.`
      );
    }

    const current = this.patchAdapter.compile(request.currentDsl, request.scope);
    if (current.graph.revision !== request.expectedLiveRevision) {
      throw new Error(
        `Recovery currentDsl revision ${current.graph.revision} does not match ` +
        `the inspected live revision ${request.expectedLiveRevision}`
      );
    }
    const observed = reconstructManagedGraph(
      current.graph,
      inspection.snapshot.patcher,
      undefined,
      (box, baseBox) => this.patchAdapter.resolveLiveBox(box, baseBox)
    );
    if (observed.conflicts.length > 0) {
      throw new PatchReconciliationError(observed.conflicts);
    }
    const workingDsl = this.patchAdapter.serialize(observed.graph);
    const revisionAdvanced = observed.graph.revision !== inspection.liveRevision;
    let acknowledgement: MaxforgeAppliedEvent | undefined;
    if (revisionAdvanced) {
      const key = targetKey(request.patcherId, request.scope);
      const pending = this.pendingApplies.get(key);
      if (!pending) {
        throw new Error(
          `Pending apply for Max patch "${request.patcherId}" scope ` +
          `"${request.scope}" disappeared during recovery`
        );
      }
      this.pendingApplies.set(key, {
        baseRevision: inspection.liveRevision,
        nextGraph: observed.graph,
        intentGraph: observed.graph,
        nextSource: workingDsl,
        intentSource: workingDsl,
        recoveryBaseGraph: current.graph,
        recoveryBaseSource: request.currentDsl,
        superseded: pending.superseded ?? {
          baseRevision: pending.baseRevision,
          nextGraph: pending.nextGraph,
          intentGraph: pending.intentGraph,
          nextSource: pending.nextSource,
          intentSource: pending.intentSource,
        },
      });
      this.persistState();
      acknowledgement = await this.transport.apply(request.patcherId, {
        protocolVersion: 1,
        scope: request.scope,
        baseRevision: inspection.liveRevision,
        targetRevision: observed.graph.revision,
        baseStructureToken: inspection.structureToken,
        operations: [],
        rollbackOperations: [],
      });
    }

    const key = targetKey(request.patcherId, request.scope);
    this.managedGraphs.set(key, observed.graph);
    this.intentGraphs.set(key, observed.graph);
    this.workingSources.set(key, workingDsl);
    this.intentSources.set(key, workingDsl);
    this.baselineSnapshots.set(key, inspection.snapshot.patcher);
    this.pendingApplies.delete(key);
    const persistence = this.tryPersistState();
    return {
      ...inspection,
      action: request.action,
      previousLiveRevision: inspection.liveRevision,
      managedRevision: observed.graph.revision,
      revisionAdvanced,
      ...(acknowledgement ? { acknowledgement } : {}),
      statePersisted: persistence.persisted,
      ...(persistence.warning ? { stateWarning: persistence.warning } : {}),
      workingDsl,
    };
  }

  private async assertNoManagedDrift(
    patcherId: string,
    scope: string,
    current: PatchGraph,
    expectedStructureToken?: string
  ): Promise<string> {
    const key = targetKey(patcherId, scope);
    const baseline = this.baselineSnapshots.get(key);
    const snapshot = await this.inspectOrReuse(
      patcherId,
      scope,
      expectedStructureToken
    );
    this.assertInspectionRevision(patcherId, scope, current, snapshot);

    let managedChangeCount = 0;
    if (baseline) {
      managedChangeCount = diffPatcherSnapshots(
        baseline,
        snapshot.patcher
      ).filter((change) => change.managed).length;
    } else if (
      snapshot.revision !== null ||
      current.patcher.boxes.length > 0 ||
      current.patcher.connections.length > 0
    ) {
      const observed = reconstructManagedGraph(
        current,
        snapshot.patcher,
        undefined,
        (box, baseBox) => this.patchAdapter.resolveLiveBox(box, baseBox)
      );
      managedChangeCount =
        diffPatchGraphs(current, observed.graph).operations.length +
        observed.conflicts.length +
        observed.externalConnections.length;
    }

    if (managedChangeCount === 0) return snapshot.structureToken;
    throw new Error(
      `Max patch "${patcherId}" scope "${scope}" has ` +
      `${managedChangeCount} managed ` +
      "manual change(s) since the last acknowledged apply. Inspect the live " +
      "patch and reconcile it before applying new DSL."
    );
  }

  private async captureBaseline(
    patcherId: string,
    scope: string,
    expectedGraph: PatchGraph
  ): Promise<{
    captured: boolean;
    verification?: PostApplyVerification;
    warning?: string;
  }> {
    const key = targetKey(patcherId, scope);
    try {
      const snapshot = await this.transport.inspect(patcherId, scope);
      this.latestInspections.set(key, snapshot);
      if (snapshot.revision !== expectedGraph.revision) {
        throw new Error(
          `inspection revision ${snapshot.revision ?? "uninitialized"} does ` +
          `not match acknowledged revision ${expectedGraph.revision}`
        );
      }
      const observed = reconstructManagedGraph(
        expectedGraph,
        snapshot.patcher,
        undefined,
        (box, baseBox) => this.patchAdapter.resolveLiveBox(box, baseBox)
      );
      if (
        observed.conflicts.length > 0 ||
        observed.graph.revision !== expectedGraph.revision
      ) {
        throw new Error(
          "post-apply snapshot does not match the acknowledged target graph"
        );
      }
      this.baselineSnapshots.set(key, snapshot.patcher);
      return {
        captured: true,
        verification: {
          revision: expectedGraph.revision,
          structureToken: snapshot.structureToken,
          boxCount: snapshot.patcher.boxes.length,
          connectionCount: snapshot.patcher.connections.length,
        },
      };
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

  private async inspectOrReuse(
    patcherId: string,
    scope: string,
    expectedStructureToken?: string
  ): Promise<MaxforgeSnapshotEvent> {
    const key = targetKey(patcherId, scope);
    if (expectedStructureToken !== undefined) {
      const cached = this.latestInspections.get(key);
      if (!cached || cached.structureToken !== expectedStructureToken) {
        throw new Error(
          `No cached inspection matches structure token ${expectedStructureToken} ` +
          `for Max patch "${patcherId}" scope "${scope}". Inspect the patch again.`
        );
      }
      return cached;
    }
    const snapshot = await this.transport.inspect(patcherId, scope);
    this.latestInspections.set(key, snapshot);
    return snapshot;
  }

  private resolveCurrentGraph(request: CompilePlanRequest): {
    graph: PatchGraph;
    warnings: readonly CompileWarning[];
  } {
    this.resolvePendingApply(targetKey(request.patcherId, request.scope));
    if (request.currentDsl !== undefined) {
      return this.patchAdapter.compile(request.currentDsl, request.scope);
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

  private resolvePendingApply(key: string): void {
    const pending = this.pendingApplies.get(key);
    if (!pending) return;
    const separator = key.lastIndexOf(":");
    const patcherId = key.slice(0, separator);
    const scope = key.slice(separator + 1);
    const liveRevision = this.transport.getLiveRevision(patcherId, scope);
    if (liveRevision === undefined) {
      throw new Error(
        `Pending apply for Max patch "${patcherId}" scope "${scope}" cannot ` +
        "be resolved until that patch is connected"
      );
    }
    if (pending.superseded) {
      throw new Error(
        `Pending recovery for Max patch "${patcherId}" scope "${scope}" ` +
        "requires explicit maxforge_inspect_pending_apply and " +
        "maxforge_recover_pending_apply"
      );
    }
    const observedRevision = liveRevision ?? createEmptyPatchGraph(scope).revision;
    if (observedRevision === pending.nextGraph.revision) {
      this.managedGraphs.set(key, pending.nextGraph);
      this.intentGraphs.set(key, pending.intentGraph);
      this.workingSources.set(key, pending.nextSource);
      this.intentSources.set(key, pending.intentSource);
      this.baselineSnapshots.delete(key);
      this.pendingApplies.delete(key);
      this.persistState();
      return;
    }
    if (observedRevision === pending.baseRevision) {
      this.pendingApplies.delete(key);
      this.persistState();
      return;
    }
    throw new Error(
      `Pending apply for Max patch "${patcherId}" scope "${scope}" is ` +
      `ambiguous: Max reports ${liveRevision ?? "uninitialized"}, expected ` +
      `${pending.baseRevision} or ${pending.nextGraph.revision}`
    );
  }

  private persistState(): void {
    this.stateStore?.save({
      managedGraphs: this.managedGraphs,
      intentGraphs: this.intentGraphs,
      workingSources: this.workingSources,
      intentSources: this.intentSources,
      baselineSnapshots: this.baselineSnapshots,
      pendingApplies: this.pendingApplies,
    });
  }

  private tryPersistState(): { persisted: boolean; warning?: string } {
    try {
      this.persistState();
      return { persisted: true };
    } catch (error) {
      return {
        persisted: false,
        warning:
          "Max applied the patch, but maxforge could not persist MCP state: " +
          (error instanceof Error ? error.message : String(error)),
      };
    }
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

  private requireEditHistoryStore(): EditHistoryStore {
    if (!this.editHistoryStore) {
      throw new Error(
        "Patch history identity management requires persistent edit history and a configured project.id"
      );
    }
    return this.editHistoryStore;
  }
}

function adoptionRepresentationIssue(
  changes: readonly PatchSnapshotChange[]
): string | undefined {
  if (changes.some((change) =>
    change.managed && (
      change.kind === "connection_changed" ||
      (
        (change.kind === "connection_added" ||
          change.kind === "connection_removed") &&
        Object.keys(change.connection.attributes).length > 0
      )
    )
  )) {
    return "Managed patch-cord attribute edits cannot be adopted because " +
      "protocol version 1 does not represent patch-cord metadata in the " +
      "managed PatchGraph. Revert the metadata edit or recreate the cord " +
      "without relying on its attributes.";
  }
  return undefined;
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

function elapsedMilliseconds(startedAt: number, endedAt: number): number {
  return Math.round(Math.max(0, endedAt - startedAt) * 100) / 100;
}
