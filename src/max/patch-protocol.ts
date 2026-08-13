import type { PatchPlan, PatchSetValue } from "./patch-graph.js";

export interface MaxforgePatchInfo {
  readonly patcherId: string;
  readonly scope: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly revision: string | null;
  readonly controller: boolean;
  readonly title: string;
  readonly filename: string;
  readonly filepath: string;
  readonly capabilities: readonly string[];
}

export interface MaxforgePatchRegistration
  extends Omit<MaxforgePatchInfo, "sessionId"> {
  readonly type: "maxforge.registered";
  readonly observationBaseline: MaxforgeObservationBaseline;
}

export interface MaxforgeObservationBaseline {
  readonly structureToken: string;
  readonly patcher: MaxforgePatcherSnapshot;
}

export interface MaxforgeAppliedEvent {
  readonly type: "maxforge.applied";
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly revision: string;
  readonly operations: number;
}

export interface MaxforgeRevisionEvent {
  readonly type: "maxforge.revision";
  readonly patcherId: string;
  readonly scope: string;
  readonly revision: string | null;
}

export interface MaxforgeErrorEvent {
  readonly type: "maxforge.error";
  readonly requestId?: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly message: string;
}

export interface MaxforgePatchCreatedEvent {
  readonly type: "maxforge.patch.created";
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
}

export interface MaxforgePatchOpenedEvent {
  readonly type: "maxforge.patch.opened";
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
}

export interface MaxforgePatchSavedEvent {
  readonly type: "maxforge.patch.saved";
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly filename: string;
  readonly filepath: string;
  readonly dirty: boolean;
}

export interface MaxforgePatchClosingEvent {
  readonly type: "maxforge.patch.closing";
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly discarded: boolean;
}

export interface MaxforgeSnapshotBox {
  readonly targetPath: readonly string[];
  readonly runtimeId: string;
  readonly varName: string;
  readonly maxclass: string;
  readonly patchingRect: readonly [number, number, number, number];
  readonly managed: boolean;
  readonly text?: string;
  readonly comment?: string;
  readonly attributes: Readonly<Record<string, PatchSetValue>>;
}

export type MaxforgeEditObservationCause =
  | "patcher"
  | "box"
  | "line"
  | "attribute"
  | "unknown";

export interface MaxforgeEditObservedEvent {
  readonly type: "maxforge.edit.observed";
  readonly patcherId: string;
  readonly scope: string;
  readonly revision: string | null;
  readonly structureToken: string;
  readonly causes: readonly MaxforgeEditObservationCause[];
  readonly patcher: MaxforgePatcherSnapshot;
}

export interface MaxforgeRetainedEditObservation {
  readonly sequence: number;
  readonly sessionSequence: number;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly sessionStartedAt: string;
  readonly sessionBaseline: MaxforgeObservationBaseline;
  readonly observedAt: string;
  readonly event: MaxforgeEditObservedEvent;
}

export interface MaxforgeEditObservationHistory {
  readonly supported: boolean;
  readonly droppedEvents: number;
  readonly persistence: MaxforgeEditHistoryPersistence;
  readonly identity: MaxforgePatchHistoryIdentityStatus | null;
  readonly patchMetadata: readonly MaxforgePatchMetadata[];
  readonly observations: readonly MaxforgeRetainedEditObservation[];
}

export interface MaxforgePatchHistoryIdentity {
  readonly patcherId: string;
  readonly scope: string;
}

export type MaxforgePatchHistoryIdentityAction = "rekey" | "merge" | "forget";

export interface ResolveMaxforgePatchHistoryIdentityRequest {
  readonly action: MaxforgePatchHistoryIdentityAction;
  readonly expectedProjectId: string;
  readonly source: MaxforgePatchHistoryIdentity;
  readonly target?: MaxforgePatchHistoryIdentity;
  readonly reason: string;
  readonly resolvedAt?: string;
}

export interface MaxforgePatchHistoryIdentityDecision {
  readonly action: MaxforgePatchHistoryIdentityAction;
  readonly source: MaxforgePatchHistoryIdentity;
  readonly target?: MaxforgePatchHistoryIdentity;
  readonly reason: string;
  readonly resolvedAt: string;
}

export interface MaxforgePatchHistoryIdentityStatus {
  readonly projectId: string;
  readonly requested: MaxforgePatchHistoryIdentity;
  readonly canonical: MaxforgePatchHistoryIdentity;
  readonly known: boolean;
  readonly forgotten: boolean;
  readonly aliases: readonly MaxforgePatchHistoryIdentity[];
  readonly decisions: readonly MaxforgePatchHistoryIdentityDecision[];
}

export interface ResolveMaxforgePatchHistoryIdentityResult
  extends MaxforgePatchHistoryIdentityStatus {
  readonly action: MaxforgePatchHistoryIdentityAction;
  readonly physicalDataErased: false;
}

export interface EraseMaxforgeProjectHistoryRequest {
  readonly expectedProjectId: string;
  readonly confirmation: string;
}

export interface EraseMaxforgeProjectHistoryResult {
  readonly projectId: string;
  readonly location: string;
  readonly filesDeleted: number;
  readonly bytesDeleted: number;
  readonly retainedObservationsCleared: number;
  readonly directoryRemoved: boolean;
  readonly physicalDataDeleted: boolean;
  readonly secureOverwriteGuaranteed: false;
}

export interface MaxforgeEditHistoryPersistence {
  readonly enabled: boolean;
  readonly projectId: string | null;
  readonly location: string | null;
  readonly warnings: readonly string[];
}

export interface MaxforgePatchMetadata {
  readonly projectId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly observedAt: string;
  readonly reason: "registered" | "saved";
  readonly title: string;
  readonly filename: string;
  readonly filepath: string;
}

export interface MaxforgeSnapshotEndpoint {
  readonly runtimeId: string;
  readonly varName: string;
  readonly port: number;
}

export interface MaxforgeSnapshotConnection {
  readonly targetPath: readonly string[];
  readonly source: MaxforgeSnapshotEndpoint;
  readonly destination: MaxforgeSnapshotEndpoint;
  readonly attributes: Readonly<Record<string, PatchSetValue>>;
}

export interface MaxforgePatcherSnapshot {
  readonly title: string;
  readonly filename: string;
  readonly filepath: string;
  readonly dirty: boolean;
  readonly locked: boolean;
  readonly presentation: boolean;
  readonly boxes: readonly MaxforgeSnapshotBox[];
  readonly connections: readonly MaxforgeSnapshotConnection[];
}

export interface MaxforgeSnapshotEvent {
  readonly type: "maxforge.snapshot";
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly revision: string | null;
  readonly structureToken: string;
  readonly patcher: MaxforgePatcherSnapshot;
}

export type MaxforgeBridgeEvent =
  | MaxforgePatchRegistration
  | MaxforgeAppliedEvent
  | MaxforgeRevisionEvent
  | MaxforgeErrorEvent
  | MaxforgePatchCreatedEvent
  | MaxforgePatchOpenedEvent
  | MaxforgePatchSavedEvent
  | MaxforgePatchClosingEvent
  | MaxforgeSnapshotEvent
  | MaxforgeEditObservedEvent;

export interface MaxforgeBridgeStatus {
  readonly host: string;
  readonly port: number;
  readonly connectedClients: number;
  readonly registeredPatches: readonly MaxforgePatchInfo[];
  readonly liveRevisions: Readonly<Record<string, string | null>>;
  readonly editHistoryPersistence: MaxforgeEditHistoryPersistence;
}

export interface CreateMaxPatchRequest {
  readonly patcherId: string;
  readonly scope: string;
  readonly title: string;
}

export interface OpenMaxPatchRequest extends CreateMaxPatchRequest {
  readonly path: string;
}

export interface SaveMaxPatchRequest {
  readonly patcherId: string;
  readonly scope: string;
  readonly path?: string;
  readonly overwrite?: boolean;
}

export interface CloseMaxPatchRequest {
  readonly patcherId: string;
  readonly scope: string;
  readonly discard?: boolean;
}

export interface PatchPlanTransport {
  apply(
    patcherId: string,
    plan: PatchPlan
  ): Promise<MaxforgeAppliedEvent>;
  inspect(
    patcherId: string,
    scope: string
  ): Promise<MaxforgeSnapshotEvent>;
  getEditObservationHistory(
    patcherId: string,
    scope: string
  ): MaxforgeEditObservationHistory;
  clearEditObservationHistory(): number;
  createPatch(request: CreateMaxPatchRequest): Promise<MaxforgePatchInfo>;
  openPatch(request: OpenMaxPatchRequest): Promise<MaxforgePatchInfo>;
  savePatch(request: SaveMaxPatchRequest): Promise<MaxforgePatchSavedEvent>;
  closePatch(request: CloseMaxPatchRequest): Promise<MaxforgePatchClosingEvent>;
  listPatches(): readonly MaxforgePatchInfo[];
  getLiveRevision(
    patcherId: string,
    scope: string
  ): string | null | undefined;
  getStatus(): MaxforgeBridgeStatus;
}

export interface MaxforgeBridgeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly applyTimeoutMs?: number;
}
