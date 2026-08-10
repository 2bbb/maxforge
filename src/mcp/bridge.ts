import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { PatchPlan, PatchSetValue } from "../max/patch-graph.js";
import type {
  CloseMaxPatchRequest,
  CreateMaxPatchRequest,
  MaxforgeAppliedEvent,
  MaxforgeBridgeEvent,
  MaxforgeBridgeOptions,
  MaxforgeBridgeStatus,
  MaxforgeEditObservationHistory,
  MaxforgeEditObservedEvent,
  MaxforgeErrorEvent,
  MaxforgePatchClosingEvent,
  MaxforgePatchCreatedEvent,
  MaxforgePatchInfo,
  MaxforgePatchOpenedEvent,
  MaxforgePatchRegistration,
  MaxforgePatchSavedEvent,
  MaxforgePatcherSnapshot,
  MaxforgeRevisionEvent,
  MaxforgeSnapshotBox,
  MaxforgeSnapshotConnection,
  MaxforgeSnapshotEndpoint,
  MaxforgeSnapshotEvent,
  OpenMaxPatchRequest,
  PatchPlanTransport,
  SaveMaxPatchRequest,
} from "../max/patch-protocol.js";

interface RegisteredClient {
  readonly client: WebSocket;
  info: MaxforgePatchInfo;
}

interface StoredEditObservation {
  readonly client: WebSocket;
  readonly patcherId: string;
  readonly scope: string;
  readonly byteSize: number;
  readonly sequence: number;
  readonly observedAt: string;
  readonly event: MaxforgeEditObservedEvent;
}

interface PendingApply {
  readonly kind: "apply";
  readonly client: WebSocket;
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly targetRevision: string;
  readonly resolve: (event: MaxforgeAppliedEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface PendingInspection {
  readonly kind: "inspection";
  readonly client: WebSocket;
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly resolve: (event: MaxforgeSnapshotEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface PendingCreate {
  readonly client: WebSocket;
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly resolve: (patch: MaxforgePatchInfo) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  created: boolean;
  registration?: MaxforgePatchInfo;
}

interface PendingOpen extends PendingCreate {
  readonly path: string;
}

interface PendingSave {
  readonly client: WebSocket;
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly resolve: (event: MaxforgePatchSavedEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface PendingClose {
  readonly client: WebSocket;
  readonly requestId: string;
  readonly patcherId: string;
  readonly scope: string;
  readonly resolve: (event: MaxforgePatchClosingEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const STRUCTURE_TOKEN_PATTERN = /^[a-f0-9]{16}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_PATH_LENGTH = 2047;
const MAX_EDIT_OBSERVATIONS = 128;
const MAX_EDIT_OBSERVATION_BYTES = 32 * 1024 * 1024;

export class MaxforgeWebSocketBridge implements PatchPlanTransport {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly token: string | undefined;
  private readonly applyTimeoutMs: number;
  private readonly clients = new Set<WebSocket>();
  private readonly authenticatedClients = new Set<WebSocket>();
  private readonly registrations = new Map<string, RegisteredClient>();
  private readonly clientPatcherIds = new Map<WebSocket, string>();
  private readonly pendingApplies = new Map<string, PendingApply>();
  private readonly pendingInspections = new Map<string, PendingInspection>();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private readonly pendingSaves = new Map<string, PendingSave>();
  private readonly pendingCloses = new Map<string, PendingClose>();
  private readonly pendingOperations = new Map<string, string>();
  private readonly editObservations: StoredEditObservation[] = [];
  private readonly droppedEditEvents = new Map<string, number>();
  private server: WebSocketServer | undefined;
  private listeningPort: number | undefined;
  private nextEditSequence = 1;
  private editObservationBytes = 0;

  constructor(options: MaxforgeBridgeOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 8766;
    this.token = options.token;
    this.applyTimeoutMs = options.applyTimeoutMs ?? 5000;

    if (this.token !== undefined && !TOKEN_PATTERN.test(this.token)) {
      throw new Error(
        "WebSocket token must contain 1 to 256 URL-safe characters"
      );
    }
    if (!isLoopbackHost(this.host) && this.token === undefined) {
      throw new Error(
        `WebSocket token is required for non-loopback host "${this.host}"`
      );
    }
    if (
      !Number.isInteger(this.requestedPort) ||
      this.requestedPort < 0 ||
      this.requestedPort > 65535
    ) {
      throw new Error(`Invalid WebSocket port: ${this.requestedPort}`);
    }
    if (!Number.isFinite(this.applyTimeoutMs) || this.applyTimeoutMs <= 0) {
      throw new Error(`Invalid apply timeout: ${this.applyTimeoutMs}`);
    }
  }

  async start(): Promise<MaxforgeBridgeStatus> {
    if (this.server) {
      throw new Error("WebSocket bridge is already started");
    }

    const server = new WebSocketServer({
      host: this.host,
      port: this.requestedPort,
      maxPayload: MAX_MESSAGE_BYTES,
    });
    this.server = server;
    server.on("connection", (client) => this.addClient(client));

    await new Promise<void>((resolve, reject) => {
      const handleListening = () => {
        server.off("error", handleStartupError);
        resolve();
      };
      const handleStartupError = (error: Error) => {
        server.off("listening", handleListening);
        this.server = undefined;
        reject(error);
      };
      server.once("listening", handleListening);
      server.once("error", handleStartupError);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Could not determine WebSocket listening port");
    }
    this.listeningPort = address.port;
    server.on("error", (error) => this.rejectAllPending(error));
    return this.getStatus();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listeningPort = undefined;
    this.rejectAllPending(new Error("WebSocket bridge closed"));

    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.authenticatedClients.clear();
    this.registrations.clear();
    this.clientPatcherIds.clear();
    this.editObservations.splice(0);
    this.droppedEditEvents.clear();
    this.editObservationBytes = 0;

    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async apply(
    patcherId: string,
    plan: PatchPlan
  ): Promise<MaxforgeAppliedEvent> {
    const registration = this.getRegisteredClient(patcherId, plan.scope);
    this.assertPatchIsIdle(patcherId);
    const requestId = randomUUID();

    return new Promise<MaxforgeAppliedEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectApply(
          requestId,
          new Error(
            `Timed out waiting for Max patch "${patcherId}" to acknowledge ` +
            `scope "${plan.scope}"`
          )
        );
      }, this.applyTimeoutMs);
      const pending: PendingApply = {
        kind: "apply",
        client: registration.client,
        requestId,
        patcherId,
        scope: plan.scope,
        targetRevision: plan.targetRevision,
        resolve,
        reject,
        timeout,
      };
      this.pendingApplies.set(requestId, pending);
      this.pendingOperations.set(patcherId, requestId);

      registration.client.send(JSON.stringify({
        type: "maxforge.apply.request",
        requestId,
        patcherId,
        plan,
      }), (error) => {
        if (error) this.rejectApply(requestId, error);
      });
    });
  }

  async inspect(
    patcherId: string,
    scope: string
  ): Promise<MaxforgeSnapshotEvent> {
    const registration = this.getRegisteredClient(patcherId, scope);
    this.assertPatchIsIdle(patcherId);
    const requestId = randomUUID();

    return new Promise<MaxforgeSnapshotEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectInspection(
          requestId,
          new Error(
            `Timed out waiting for Max patch "${patcherId}" to inspect ` +
            `scope "${scope}"`
          )
        );
      }, this.applyTimeoutMs);
      const pending: PendingInspection = {
        kind: "inspection",
        client: registration.client,
        requestId,
        patcherId,
        scope,
        resolve,
        reject,
        timeout,
      };
      this.pendingInspections.set(requestId, pending);
      this.pendingOperations.set(patcherId, requestId);

      registration.client.send(JSON.stringify({
        type: "maxforge.inspect.request",
        requestId,
        patcherId,
        scope,
      }), (error) => {
        if (error) this.rejectInspection(requestId, error);
      });
    });
  }

  getEditObservationHistory(
    patcherId: string,
    scope: string
  ): MaxforgeEditObservationHistory {
    const registration = this.getRegisteredClient(patcherId, scope);
    const supported = registration.info.capabilities.includes(
      "edit_observation_v1"
    );
    const key = targetKey(patcherId, scope);
    return {
      supported,
      droppedEvents: this.droppedEditEvents.get(key) ?? 0,
      observations: this.editObservations
        .filter((entry) =>
          entry.client === registration.client &&
          entry.patcherId === patcherId &&
          entry.scope === scope
        )
        .map(({ sequence, observedAt, event }) => ({
          sequence,
          observedAt,
          event,
        })),
    };
  }

  async createPatch(request: CreateMaxPatchRequest): Promise<MaxforgePatchInfo> {
    this.validateNewPatchRequest(request, "Creation");
    const controller = this.getSingleController();
    const requestId = randomUUID();

    return new Promise<MaxforgePatchInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingCreates.get(requestId);
        const missing = pending?.created
          ? "registration"
          : "creation acknowledgement and registration";
        this.rejectCreate(
          requestId,
          new Error(
            `Timed out waiting for Max patch "${request.patcherId}" to be ` +
            `created and registered; missing ${missing}`
          )
        );
      }, this.applyTimeoutMs);
      this.pendingCreates.set(requestId, {
        client: controller.client,
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        resolve,
        reject,
        timeout,
        created: false,
      });

      controller.client.send(JSON.stringify({
        type: "maxforge.create_patch.request",
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        title: request.title,
      }), (error) => {
        if (error) this.rejectCreate(requestId, error);
      });
    });
  }

  async openPatch(request: OpenMaxPatchRequest): Promise<MaxforgePatchInfo> {
    this.validateNewPatchRequest(request, "Opening");
    validatePatchPath(request.path);
    const controller = this.getSingleController();
    const requestId = randomUUID();

    return new Promise<MaxforgePatchInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingOpens.get(requestId);
        const missing = pending?.created
          ? "registration"
          : "open acknowledgement and registration";
        this.rejectOpen(
          requestId,
          new Error(
            `Timed out waiting for Max patch "${request.patcherId}" to be ` +
            `opened and registered; missing ${missing}`
          )
        );
      }, this.applyTimeoutMs);
      this.pendingOpens.set(requestId, {
        client: controller.client,
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        path: request.path,
        resolve,
        reject,
        timeout,
        created: false,
      });

      controller.client.send(JSON.stringify({
        type: "maxforge.open_patch.request",
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        title: request.title,
        path: request.path,
      }), (error) => {
        if (error) this.rejectOpen(requestId, error);
      });
    });
  }

  async savePatch(
    request: SaveMaxPatchRequest
  ): Promise<MaxforgePatchSavedEvent> {
    const registration = this.getRegisteredClient(
      request.patcherId,
      request.scope
    );
    this.assertPatchIsIdle(request.patcherId);
    if (request.path !== undefined) validatePatchPath(request.path);
    const requestId = randomUUID();

    return new Promise<MaxforgePatchSavedEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectSave(
          requestId,
          new Error(
            `Timed out waiting for Max patch "${request.patcherId}" to save`
          )
        );
      }, this.applyTimeoutMs);
      this.pendingSaves.set(requestId, {
        client: registration.client,
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        resolve,
        reject,
        timeout,
      });
      this.pendingOperations.set(request.patcherId, requestId);

      registration.client.send(JSON.stringify({
        type: "maxforge.save_patch.request",
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        ...(request.path === undefined ? {} : { path: request.path }),
        overwrite: request.overwrite ?? false,
      }), (error) => {
        if (error) this.rejectSave(requestId, error);
      });
    });
  }

  async closePatch(
    request: CloseMaxPatchRequest
  ): Promise<MaxforgePatchClosingEvent> {
    const registration = this.getRegisteredClient(
      request.patcherId,
      request.scope
    );
    this.assertPatchIsIdle(request.patcherId);
    const requestId = randomUUID();

    return new Promise<MaxforgePatchClosingEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectClose(
          requestId,
          new Error(
            `Timed out waiting for Max patch "${request.patcherId}" to close`
          )
        );
      }, this.applyTimeoutMs);
      this.pendingCloses.set(requestId, {
        client: registration.client,
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        resolve,
        reject,
        timeout,
      });
      this.pendingOperations.set(request.patcherId, requestId);

      registration.client.send(JSON.stringify({
        type: "maxforge.close_patch.request",
        requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        discard: request.discard ?? false,
      }), (error) => {
        if (error) this.rejectClose(requestId, error);
      });
    });
  }

  listPatches(): readonly MaxforgePatchInfo[] {
    return [...this.registrations.values()]
      .filter(({ client }) => client.readyState === WebSocket.OPEN)
      .map(({ info }) => ({ ...info }))
      .sort((left, right) => left.patcherId.localeCompare(right.patcherId));
  }

  getLiveRevision(
    patcherId: string,
    scope: string
  ): string | null | undefined {
    const registration = this.registrations.get(patcherId);
    if (!registration || registration.info.scope !== scope) return undefined;
    return registration.info.revision;
  }

  getStatus(): MaxforgeBridgeStatus {
    const registeredPatches = this.listPatches();
    return {
      host: this.host,
      port: this.listeningPort ?? this.requestedPort,
      connectedClients: [...this.clients].filter(
        (client) => client.readyState === WebSocket.OPEN
      ).length,
      registeredPatches,
      liveRevisions: Object.fromEntries(
        registeredPatches.map((patch) => [
          `${patch.patcherId}:${patch.scope}`,
          patch.revision,
        ])
      ),
    };
  }

  private addClient(client: WebSocket): void {
    this.clients.add(client);
    if (this.token === undefined) this.authenticatedClients.add(client);
    client.on("message", (data) => this.handleMessage(client, data.toString()));
    client.on("close", () => this.removeClient(client));
    client.on("error", (error) => this.rejectPendingForClient(client, error));
  }

  private removeClient(client: WebSocket): void {
    this.clients.delete(client);
    this.authenticatedClients.delete(client);
    const patcherId = this.clientPatcherIds.get(client);
    this.clientPatcherIds.delete(client);
    if (patcherId) {
      const registration = this.registrations.get(patcherId);
      if (registration?.client === client) this.registrations.delete(patcherId);
    }
    this.rejectPendingForClient(client, new Error("Max client disconnected"));
  }

  private handleMessage(client: WebSocket, raw: string): void {
    if (!this.authenticatedClients.has(client)) {
      const suppliedToken = parseAuthenticationToken(raw);
      if (
        suppliedToken === undefined ||
        this.token === undefined ||
        !tokensEqual(suppliedToken, this.token)
      ) {
        client.close(1008, "authentication failed");
        return;
      }
      this.authenticatedClients.add(client);
      return;
    }

    const event = parseBridgeEvent(raw);
    if (!event) return;

    switch (event.type) {
      case "maxforge.registered":
        this.handleRegistration(client, event);
        return;
      case "maxforge.revision":
        this.updateRevision(client, event.patcherId, event.scope, event.revision);
        return;
      case "maxforge.snapshot":
        this.handleSnapshot(client, event);
        return;
      case "maxforge.edit.observed":
        this.handleEditObserved(client, event, Buffer.byteLength(raw));
        return;
      case "maxforge.applied":
        this.handleApplied(client, event);
        return;
      case "maxforge.patch.created":
        this.handlePatchCreated(client, event);
        return;
      case "maxforge.patch.opened":
        this.handlePatchOpened(client, event);
        return;
      case "maxforge.patch.saved":
        this.handlePatchSaved(client, event);
        return;
      case "maxforge.patch.closing":
        this.handlePatchClosing(client, event);
        return;
      case "maxforge.error":
        this.handleError(client, event);
        return;
    }
  }

  private handleRegistration(
    client: WebSocket,
    event: MaxforgePatchRegistration
  ): void {
    const existing = this.registrations.get(event.patcherId);
    if (
      existing &&
      existing.client !== client &&
      existing.client.readyState === WebSocket.OPEN
    ) {
      client.close(1008, `duplicate patcherId: ${event.patcherId}`);
      return;
    }

    const previousPatcherId = this.clientPatcherIds.get(client);
    if (previousPatcherId && previousPatcherId !== event.patcherId) {
      this.registrations.delete(previousPatcherId);
    }
    const info = patchInfo(event);
    this.clearEditObservations(event.patcherId);
    this.clientPatcherIds.set(client, event.patcherId);
    this.registrations.set(event.patcherId, { client, info });

    for (const pending of this.pendingCreates.values()) {
      if (
        pending.patcherId === event.patcherId &&
        pending.scope === event.scope
      ) {
        pending.registration = info;
        this.resolveCreateIfReady(pending);
      }
    }
    for (const pending of this.pendingOpens.values()) {
      if (
        pending.patcherId === event.patcherId &&
        pending.scope === event.scope
      ) {
        pending.registration = info;
        this.resolveOpenIfReady(pending);
      }
    }
  }

  private handleEditObserved(
    client: WebSocket,
    event: MaxforgeEditObservedEvent,
    byteSize: number
  ): void {
    const registration = this.registrations.get(event.patcherId);
    if (
      !registration ||
      registration.client !== client ||
      registration.info.scope !== event.scope ||
      !registration.info.capabilities.includes("edit_observation_v1")
    ) {
      return;
    }

    this.editObservations.push({
      client,
      patcherId: event.patcherId,
      scope: event.scope,
      byteSize,
      sequence: this.nextEditSequence++,
      observedAt: new Date().toISOString(),
      event,
    });
    this.editObservationBytes += byteSize;
    while (
      MAX_EDIT_OBSERVATIONS < this.editObservations.length ||
      MAX_EDIT_OBSERVATION_BYTES < this.editObservationBytes
    ) {
      const removed = this.editObservations.shift();
      if (!removed) break;
      this.editObservationBytes -= removed.byteSize;
      const key = targetKey(removed.patcherId, removed.scope);
      this.droppedEditEvents.set(
        key,
        (this.droppedEditEvents.get(key) ?? 0) + 1
      );
    }
  }

  private clearEditObservations(patcherId: string): void {
    for (let index = this.editObservations.length - 1; 0 <= index; index--) {
      const entry = this.editObservations[index];
      if (entry.patcherId !== patcherId) continue;
      this.editObservationBytes -= entry.byteSize;
      this.editObservations.splice(index, 1);
    }
    for (const key of this.droppedEditEvents.keys()) {
      if (key.startsWith(`${patcherId}\u0000`)) {
        this.droppedEditEvents.delete(key);
      }
    }
  }

  private handleApplied(
    client: WebSocket,
    event: MaxforgeAppliedEvent
  ): void {
    const pending = this.pendingApplies.get(event.requestId);
    if (!pending) return;
    const mismatch = validatePendingResponse(pending, client, event);
    if (mismatch) {
      this.rejectApply(event.requestId, new Error(mismatch));
      return;
    }
    if (pending.targetRevision !== event.revision) {
      this.rejectApply(
        event.requestId,
        new Error(
          `Max patch "${event.patcherId}" acknowledged unexpected revision ` +
          `"${event.revision}"`
        )
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingApplies.delete(event.requestId);
    this.pendingOperations.delete(event.patcherId);
    this.updateRevision(
      client,
      event.patcherId,
      event.scope,
      event.revision
    );
    pending.resolve(event);
  }

  private handleSnapshot(
    client: WebSocket,
    event: MaxforgeSnapshotEvent
  ): void {
    const pending = this.pendingInspections.get(event.requestId);
    if (!pending) return;
    const mismatch = validatePendingResponse(pending, client, event);
    if (mismatch) {
      this.rejectInspection(event.requestId, new Error(mismatch));
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingInspections.delete(event.requestId);
    this.pendingOperations.delete(event.patcherId);
    this.updateRevision(
      client,
      event.patcherId,
      event.scope,
      event.revision
    );
    pending.resolve(event);
  }

  private handlePatchCreated(
    client: WebSocket,
    event: MaxforgePatchCreatedEvent
  ): void {
    const pending = this.pendingCreates.get(event.requestId);
    if (!pending) return;
    if (
      pending.client !== client ||
      pending.patcherId !== event.patcherId ||
      pending.scope !== event.scope
    ) {
      this.rejectCreate(
        event.requestId,
        new Error("Max returned a mismatched patch creation acknowledgement")
      );
      return;
    }
    pending.created = true;
    this.resolveCreateIfReady(pending);
  }

  private handlePatchOpened(
    client: WebSocket,
    event: MaxforgePatchOpenedEvent
  ): void {
    const pending = this.pendingOpens.get(event.requestId);
    if (!pending) return;
    if (
      pending.client !== client ||
      pending.patcherId !== event.patcherId ||
      pending.scope !== event.scope
    ) {
      this.rejectOpen(
        event.requestId,
        new Error("Max returned a mismatched patch open acknowledgement")
      );
      return;
    }
    pending.created = true;
    this.resolveOpenIfReady(pending);
  }

  private handlePatchSaved(
    client: WebSocket,
    event: MaxforgePatchSavedEvent
  ): void {
    const pending = this.pendingSaves.get(event.requestId);
    if (!pending) return;
    const mismatch = validatePendingResponse(pending, client, event);
    if (mismatch) {
      this.rejectSave(event.requestId, new Error(mismatch));
      return;
    }
    if (event.dirty || event.filepath.length === 0) {
      this.rejectSave(
        event.requestId,
        new Error(
          `Max patch "${event.patcherId}" acknowledged save without a clean file path`
        )
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingSaves.delete(event.requestId);
    this.pendingOperations.delete(event.patcherId);
    const registration = this.registrations.get(event.patcherId);
    if (registration?.client === client) {
      registration.info = {
        ...registration.info,
        filename: event.filename,
        filepath: event.filepath,
      };
    }
    pending.resolve(event);
  }

  private handlePatchClosing(
    client: WebSocket,
    event: MaxforgePatchClosingEvent
  ): void {
    const pending = this.pendingCloses.get(event.requestId);
    if (!pending) return;
    const mismatch = validatePendingResponse(pending, client, event);
    if (mismatch) {
      this.rejectClose(event.requestId, new Error(mismatch));
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCloses.delete(event.requestId);
    this.pendingOperations.delete(event.patcherId);
    const registration = this.registrations.get(event.patcherId);
    if (registration?.client === client) {
      this.registrations.delete(event.patcherId);
      this.clientPatcherIds.delete(client);
    }
    pending.resolve(event);
  }

  private handleError(client: WebSocket, event: MaxforgeErrorEvent): void {
    if (!event.requestId) return;
    const pendingApply = this.pendingApplies.get(event.requestId);
    if (pendingApply) {
      if (pendingApply.client !== client) return;
      this.rejectApply(
        event.requestId,
        new Error(
          `Max patch "${event.patcherId}" rejected request ` +
          `"${event.requestId}": ${event.message}`
        )
      );
      return;
    }
    const pendingInspection = this.pendingInspections.get(event.requestId);
    if (pendingInspection) {
      if (pendingInspection.client !== client) return;
      this.rejectInspection(
        event.requestId,
        new Error(
          `Max patch "${event.patcherId}" rejected request ` +
          `"${event.requestId}": ${event.message}`
        )
      );
      return;
    }
    const pendingCreate = this.pendingCreates.get(event.requestId);
    if (pendingCreate?.client === client) {
      this.rejectCreate(
        event.requestId,
        new Error(
          `Max controller rejected patch creation for ` +
          `"${pendingCreate.patcherId}": ${event.message}`
        )
      );
      return;
    }
    const pendingOpen = this.pendingOpens.get(event.requestId);
    if (pendingOpen?.client === client) {
      this.rejectOpen(
        event.requestId,
        new Error(
          `Max controller rejected patch open for ` +
          `"${pendingOpen.patcherId}": ${event.message}`
        )
      );
      return;
    }
    const pendingSave = this.pendingSaves.get(event.requestId);
    if (pendingSave?.client === client) {
      this.rejectSave(
        event.requestId,
        new Error(
          `Max patch "${pendingSave.patcherId}" rejected save: ${event.message}`
        )
      );
      return;
    }
    const pendingClose = this.pendingCloses.get(event.requestId);
    if (pendingClose?.client === client) {
      this.rejectClose(
        event.requestId,
        new Error(
          `Max patch "${pendingClose.patcherId}" rejected close: ${event.message}`
        )
      );
    }
  }

  private updateRevision(
    client: WebSocket,
    patcherId: string,
    scope: string,
    revision: string | null
  ): void {
    const registration = this.registrations.get(patcherId);
    if (
      !registration ||
      registration.client !== client ||
      registration.info.scope !== scope
    ) {
      return;
    }
    registration.info = { ...registration.info, revision };
  }

  private getRegisteredClient(
    patcherId: string,
    scope: string
  ): RegisteredClient {
    this.assertStarted();
    const registration = this.registrations.get(patcherId);
    if (
      !registration ||
      registration.client.readyState !== WebSocket.OPEN
    ) {
      throw new Error(`Max patch "${patcherId}" is not registered`);
    }
    if (registration.info.scope !== scope) {
      throw new Error(
        `Max patch "${patcherId}" manages scope ` +
        `"${registration.info.scope}", not "${scope}"`
      );
    }
    return registration;
  }

  private assertStarted(): void {
    if (!this.server || this.listeningPort === undefined) {
      throw new Error("WebSocket bridge is not started");
    }
  }

  private assertPatchIsIdle(patcherId: string): void {
    const requestId = this.pendingOperations.get(patcherId);
    if (requestId) {
      throw new Error(
        `Max patch "${patcherId}" already has pending request "${requestId}"`
      );
    }
  }

  private validateNewPatchRequest(
    request: CreateMaxPatchRequest,
    operation: string
  ): void {
    this.assertStarted();
    if (!IDENTIFIER_PATTERN.test(request.patcherId)) {
      throw new Error(`Invalid patcherId: "${request.patcherId}"`);
    }
    if (!IDENTIFIER_PATTERN.test(request.scope)) {
      throw new Error(`Invalid scope: "${request.scope}"`);
    }
    if (request.title.length === 0 || 256 < request.title.length) {
      throw new Error("Patch title must contain between 1 and 256 characters");
    }
    if (this.registrations.has(request.patcherId)) {
      throw new Error(`Max patch "${request.patcherId}" is already registered`);
    }
    if (
      [...this.pendingCreates.values(), ...this.pendingOpens.values()].some(
        (pending) => pending.patcherId === request.patcherId
      )
    ) {
      throw new Error(
        `${operation} of Max patch "${request.patcherId}" is already pending`
      );
    }
  }

  private getSingleController(): RegisteredClient {
    const controllers = [...this.registrations.values()].filter(
      ({ client, info }) =>
        info.controller && client.readyState === WebSocket.OPEN
    );
    if (controllers.length !== 1) {
      throw new Error(
        "Exactly one patch-creation controller is required, " +
        `registered: ${controllers.length}`
      );
    }
    return controllers[0];
  }

  private resolveCreateIfReady(pending: PendingCreate): void {
    if (!pending.created || !pending.registration) return;
    clearTimeout(pending.timeout);
    this.pendingCreates.delete(pending.requestId);
    pending.resolve(pending.registration);
  }

  private resolveOpenIfReady(pending: PendingOpen): void {
    if (!pending.created || !pending.registration) return;
    clearTimeout(pending.timeout);
    this.pendingOpens.delete(pending.requestId);
    pending.resolve(pending.registration);
  }

  private rejectApply(requestId: string, error: Error): void {
    const pending = this.pendingApplies.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingApplies.delete(requestId);
    this.pendingOperations.delete(pending.patcherId);
    pending.reject(error);
  }

  private rejectInspection(requestId: string, error: Error): void {
    const pending = this.pendingInspections.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingInspections.delete(requestId);
    this.pendingOperations.delete(pending.patcherId);
    pending.reject(error);
  }

  private rejectCreate(requestId: string, error: Error): void {
    const pending = this.pendingCreates.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCreates.delete(requestId);
    pending.reject(error);
  }

  private rejectOpen(requestId: string, error: Error): void {
    const pending = this.pendingOpens.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingOpens.delete(requestId);
    pending.reject(error);
  }

  private rejectSave(requestId: string, error: Error): void {
    const pending = this.pendingSaves.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingSaves.delete(requestId);
    this.pendingOperations.delete(pending.patcherId);
    pending.reject(error);
  }

  private rejectClose(requestId: string, error: Error): void {
    const pending = this.pendingCloses.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCloses.delete(requestId);
    this.pendingOperations.delete(pending.patcherId);
    pending.reject(error);
  }

  private rejectPendingForClient(client: WebSocket, error: Error): void {
    for (const pending of [...this.pendingApplies.values()]) {
      if (pending.client === client) this.rejectApply(pending.requestId, error);
    }
    for (const pending of [...this.pendingInspections.values()]) {
      if (pending.client === client) {
        this.rejectInspection(pending.requestId, error);
      }
    }
    for (const pending of [...this.pendingCreates.values()]) {
      if (pending.client === client) this.rejectCreate(pending.requestId, error);
    }
    for (const pending of [...this.pendingOpens.values()]) {
      if (pending.client === client) this.rejectOpen(pending.requestId, error);
    }
    for (const pending of [...this.pendingSaves.values()]) {
      if (pending.client === client) this.rejectSave(pending.requestId, error);
    }
    for (const pending of [...this.pendingCloses.values()]) {
      if (pending.client === client) this.rejectClose(pending.requestId, error);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const requestId of [...this.pendingApplies.keys()]) {
      this.rejectApply(requestId, error);
    }
    for (const requestId of [...this.pendingInspections.keys()]) {
      this.rejectInspection(requestId, error);
    }
    for (const requestId of [...this.pendingCreates.keys()]) {
      this.rejectCreate(requestId, error);
    }
    for (const requestId of [...this.pendingOpens.keys()]) {
      this.rejectOpen(requestId, error);
    }
    for (const requestId of [...this.pendingSaves.keys()]) {
      this.rejectSave(requestId, error);
    }
    for (const requestId of [...this.pendingCloses.keys()]) {
      this.rejectClose(requestId, error);
    }
  }
}

export function parseBridgeEvent(raw: string): MaxforgeBridgeEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !isIdentifier(value.patcherId) ||
    !isIdentifier(value.scope)
  ) {
    return undefined;
  }

  if (
    value.type === "maxforge.registered" &&
    isRevisionOrNull(value.revision) &&
    typeof value.controller === "boolean" &&
    typeof value.title === "string" &&
    typeof value.filename === "string" &&
    typeof value.filepath === "string" &&
    isPatchCapabilities(value.capabilities)
  ) {
    return {
      type: value.type,
      patcherId: value.patcherId,
      scope: value.scope,
      revision: value.revision,
      controller: value.controller,
      title: value.title,
      filename: value.filename,
      filepath: value.filepath,
      capabilities: value.capabilities,
    };
  }

  if (
    value.type === "maxforge.applied" &&
    isRequestId(value.requestId) &&
    typeof value.revision === "string" &&
    REVISION_PATTERN.test(value.revision) &&
    typeof value.operations === "number" &&
    Number.isSafeInteger(value.operations) &&
    value.operations >= 0
  ) {
    return {
      type: value.type,
      requestId: value.requestId,
      patcherId: value.patcherId,
      scope: value.scope,
      revision: value.revision,
      operations: value.operations,
    };
  }

  if (
    value.type === "maxforge.revision" &&
    isRevisionOrNull(value.revision)
  ) {
    return {
      type: value.type,
      patcherId: value.patcherId,
      scope: value.scope,
      revision: value.revision,
    };
  }

  if (
    value.type === "maxforge.error" &&
    typeof value.message === "string" &&
    (value.requestId === undefined || isRequestId(value.requestId))
  ) {
    return {
      type: value.type,
      patcherId: value.patcherId,
      scope: value.scope,
      message: value.message,
      ...(value.requestId === undefined
        ? {}
        : { requestId: value.requestId }),
    };
  }

  if (
    value.type === "maxforge.patch.created" &&
    isRequestId(value.requestId)
  ) {
    return {
      type: value.type,
      requestId: value.requestId,
      patcherId: value.patcherId,
      scope: value.scope,
    };
  }

  if (
    value.type === "maxforge.patch.opened" &&
    isRequestId(value.requestId)
  ) {
    return {
      type: value.type,
      requestId: value.requestId,
      patcherId: value.patcherId,
      scope: value.scope,
    };
  }

  if (
    value.type === "maxforge.patch.saved" &&
    isRequestId(value.requestId) &&
    typeof value.filename === "string" &&
    typeof value.filepath === "string" &&
    typeof value.dirty === "boolean"
  ) {
    return {
      type: value.type,
      requestId: value.requestId,
      patcherId: value.patcherId,
      scope: value.scope,
      filename: value.filename,
      filepath: value.filepath,
      dirty: value.dirty,
    };
  }

  if (
    value.type === "maxforge.patch.closing" &&
    isRequestId(value.requestId) &&
    typeof value.discarded === "boolean"
  ) {
    return {
      type: value.type,
      requestId: value.requestId,
      patcherId: value.patcherId,
      scope: value.scope,
      discarded: value.discarded,
    };
  }

  if (
    value.type === "maxforge.edit.observed" &&
    isRevisionOrNull(value.revision) &&
    typeof value.structureToken === "string" &&
    STRUCTURE_TOKEN_PATTERN.test(value.structureToken) &&
    isEditObservationCauses(value.causes)
  ) {
    const patcher = parsePatcherSnapshot(value.patcher);
    if (!patcher) return undefined;
    return {
      type: value.type,
      patcherId: value.patcherId,
      scope: value.scope,
      revision: value.revision,
      structureToken: value.structureToken,
      causes: value.causes,
      patcher,
    };
  }

  if (
    value.type === "maxforge.snapshot" &&
    isRequestId(value.requestId) &&
    isRevisionOrNull(value.revision) &&
    typeof value.structureToken === "string" &&
    STRUCTURE_TOKEN_PATTERN.test(value.structureToken)
  ) {
    const patcher = parsePatcherSnapshot(value.patcher);
    if (!patcher) return undefined;
    return {
      type: value.type,
      requestId: value.requestId,
      patcherId: value.patcherId,
      scope: value.scope,
      revision: value.revision,
      structureToken: value.structureToken,
      patcher,
    };
  }

  return undefined;
}

function validatePendingResponse(
  pending: PendingApply | PendingInspection | PendingSave | PendingClose,
  client: WebSocket,
  event:
    | MaxforgeAppliedEvent
    | MaxforgeSnapshotEvent
    | MaxforgePatchSavedEvent
    | MaxforgePatchClosingEvent
): string | undefined {
  if (pending.client !== client) {
    return "Received a response from an unexpected Max client";
  }
  if (
    pending.patcherId !== event.patcherId ||
    pending.scope !== event.scope
  ) {
    return (
      `Max returned patch "${event.patcherId}" scope "${event.scope}" for ` +
      `request targeting patch "${pending.patcherId}" scope "${pending.scope}"`
    );
  }
  return undefined;
}

function validatePatchPath(path: string): void {
  if (
    path.length === 0 ||
    MAX_PATCH_PATH_LENGTH < path.length ||
    path.includes("\0")
  ) {
    throw new Error(
      `Patch path must contain between 1 and ${MAX_PATCH_PATH_LENGTH} characters`
    );
  }
  if (!path.toLowerCase().endsWith(".maxpat")) {
    throw new Error(`Patch path must end with .maxpat: "${path}"`);
  }
  if (!isAbsoluteHostPath(path)) {
    throw new Error(`Patch path must be absolute on the Max host: "${path}"`);
  }
}

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(path);
}

function patchInfo(event: MaxforgePatchRegistration): MaxforgePatchInfo {
  return {
    patcherId: event.patcherId,
    scope: event.scope,
    revision: event.revision,
    controller: event.controller,
    title: event.title,
    filename: event.filename,
    filepath: event.filepath,
    capabilities: event.capabilities,
  };
}

function parsePatcherSnapshot(
  value: unknown
): MaxforgePatcherSnapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    typeof value.filename !== "string" ||
    typeof value.filepath !== "string" ||
    typeof value.dirty !== "boolean" ||
    typeof value.locked !== "boolean" ||
    typeof value.presentation !== "boolean" ||
    !Array.isArray(value.boxes) ||
    !Array.isArray(value.connections)
  ) {
    return undefined;
  }

  const boxes: MaxforgeSnapshotBox[] = [];
  for (const box of value.boxes) {
    const parsed = parseSnapshotBox(box);
    if (!parsed) return undefined;
    boxes.push(parsed);
  }
  const connections: MaxforgeSnapshotConnection[] = [];
  for (const connection of value.connections) {
    const parsed = parseSnapshotConnection(connection);
    if (!parsed) return undefined;
    connections.push(parsed);
  }
  return {
    title: value.title,
    filename: value.filename,
    filepath: value.filepath,
    dirty: value.dirty,
    locked: value.locked,
    presentation: value.presentation,
    boxes,
    connections,
  };
}

function parseSnapshotBox(value: unknown): MaxforgeSnapshotBox | undefined {
  if (
    !isRecord(value) ||
    !isStringArray(value.targetPath) ||
    typeof value.runtimeId !== "string" ||
    value.runtimeId.length === 0 ||
    typeof value.varName !== "string" ||
    typeof value.maxclass !== "string" ||
    !isRectangle(value.patchingRect) ||
    typeof value.managed !== "boolean" ||
    (value.text !== undefined && typeof value.text !== "string") ||
    (value.comment !== undefined && typeof value.comment !== "string")
  ) {
    return undefined;
  }
  const attributes = parseSnapshotAttributes(value.attributes);
  if (!attributes) return undefined;
  return {
    targetPath: value.targetPath,
    runtimeId: value.runtimeId,
    varName: value.varName,
    maxclass: value.maxclass,
    patchingRect: value.patchingRect,
    managed: value.managed,
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.comment === undefined ? {} : { comment: value.comment }),
    attributes,
  };
}

function isPatchCapabilities(
  value: unknown
): value is MaxforgePatchRegistration["capabilities"] {
  return Array.isArray(value) &&
    value.length <= 16 &&
    value.every((capability) =>
      typeof capability === "string" &&
      capability.length <= 64 &&
      IDENTIFIER_PATTERN.test(capability)
    ) &&
    new Set(value).size === value.length;
}

function isEditObservationCauses(
  value: unknown
): value is MaxforgeEditObservedEvent["causes"] {
  const allowed = new Set(["patcher", "box", "line", "attribute", "unknown"]);
  return Array.isArray(value) &&
    0 < value.length &&
    value.length <= allowed.size &&
    value.every((cause) => typeof cause === "string" && allowed.has(cause)) &&
    new Set(value).size === value.length;
}

function targetKey(patcherId: string, scope: string): string {
  return `${patcherId}\u0000${scope}`;
}

function parseSnapshotConnection(
  value: unknown
): MaxforgeSnapshotConnection | undefined {
  if (!isRecord(value) || !isStringArray(value.targetPath)) return undefined;
  const source = parseSnapshotEndpoint(value.source);
  const destination = parseSnapshotEndpoint(value.destination);
  const attributes = parseSnapshotAttributes(value.attributes);
  if (!source || !destination || !attributes) return undefined;
  return {
    targetPath: value.targetPath,
    source,
    destination,
    attributes,
  };
}

function parseSnapshotAttributes(
  value: unknown
): Readonly<Record<string, PatchSetValue>> | undefined {
  if (!isRecord(value)) return undefined;
  const attributes: Record<string, PatchSetValue> = {};
  for (const [name, attribute] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    if (typeof attribute === "string" || (
      typeof attribute === "number" && Number.isFinite(attribute)
    )) {
      attributes[name] = attribute;
      continue;
    }
    if (
      !Array.isArray(attribute) ||
      attribute.length === 0 ||
      attribute.length > 256 ||
      !attribute.every((entry) =>
        typeof entry === "string" ||
        (typeof entry === "number" && Number.isFinite(entry))
      )
    ) {
      return undefined;
    }
    attributes[name] = attribute;
  }
  return attributes;
}

function parseSnapshotEndpoint(
  value: unknown
): MaxforgeSnapshotEndpoint | undefined {
  if (
    !isRecord(value) ||
    typeof value.runtimeId !== "string" ||
    value.runtimeId.length === 0 ||
    typeof value.varName !== "string" ||
    typeof value.port !== "number" ||
    !Number.isSafeInteger(value.port) ||
    value.port < 0
  ) {
    return undefined;
  }
  return {
    runtimeId: value.runtimeId,
    varName: value.varName,
    port: value.port,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

function isRectangle(
  value: unknown
): value is [number, number, number, number] {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function isRevisionOrNull(value: unknown): value is string | null {
  return value === null ||
    (typeof value === "string" && REVISION_PATTERN.test(value));
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && 0 < value.length && value.length <= 128;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function parseAuthenticationToken(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.type !== "maxforge.authenticate" ||
      typeof value.token !== "string" ||
      !TOKEN_PATTERN.test(value.token)
    ) {
      return undefined;
    }
    return value.token;
  } catch {
    return undefined;
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
