import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { PatchPlan } from "../max/patch-graph.js";

export interface MaxforgeAppliedEvent {
  readonly type: "maxforge.applied";
  readonly scope: string;
  readonly revision: string;
  readonly operations: number;
}

export interface MaxforgeRevisionEvent {
  readonly type: "maxforge.revision";
  readonly scope: string;
  readonly revision: string | null;
}

export interface MaxforgeErrorEvent {
  readonly type: "maxforge.error";
  readonly scope: string;
  readonly message: string;
}

export interface MaxforgeSnapshotBox {
  readonly targetPath: readonly string[];
  readonly runtimeId: string;
  readonly varName: string;
  readonly maxclass: string;
  readonly patchingRect: readonly [number, number, number, number];
  readonly managed: boolean;
  readonly text?: string;
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
  readonly scope: string;
  readonly revision: string | null;
  readonly patcher: MaxforgePatcherSnapshot;
}

export type MaxforgeBridgeEvent =
  | MaxforgeAppliedEvent
  | MaxforgeRevisionEvent
  | MaxforgeErrorEvent
  | MaxforgeSnapshotEvent;

export interface MaxforgeBridgeStatus {
  readonly host: string;
  readonly port: number;
  readonly connectedClients: number;
  readonly liveRevisions: Readonly<Record<string, string | null>>;
}

export interface PatchPlanTransport {
  apply(plan: PatchPlan): Promise<MaxforgeAppliedEvent>;
  inspect(scope: string): Promise<MaxforgeSnapshotEvent>;
  getLiveRevision(scope: string): string | null | undefined;
  getStatus(): MaxforgeBridgeStatus;
}

export interface MaxforgeBridgeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly applyTimeoutMs?: number;
}

interface PendingApply {
  readonly client: WebSocket;
  readonly targetRevision: string;
  readonly resolve: (event: MaxforgeAppliedEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface PendingInspection {
  readonly client: WebSocket;
  readonly requestId: string;
  readonly scope: string;
  readonly resolve: (event: MaxforgeSnapshotEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export class MaxforgeWebSocketBridge implements PatchPlanTransport {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly applyTimeoutMs: number;
  private readonly clients = new Set<WebSocket>();
  private readonly pendingApplies = new Map<string, PendingApply>();
  private pendingInspection: PendingInspection | undefined;
  private readonly liveRevisions = new Map<string, string | null>();
  private server: WebSocketServer | undefined;
  private listeningPort: number | undefined;

  constructor(options: MaxforgeBridgeOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 8766;
    this.applyTimeoutMs = options.applyTimeoutMs ?? 5000;

    if (!isLoopbackHost(this.host)) {
      throw new Error(
        `WebSocket host must be loopback-only, received "${this.host}"`
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

    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    this.liveRevisions.clear();

    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async apply(plan: PatchPlan): Promise<MaxforgeAppliedEvent> {
    const client = this.getSoleOpenClient();
    this.assertNoPendingOperation();

    return new Promise<MaxforgeAppliedEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingApplies.delete(plan.scope);
        reject(
          new Error(
            `Timed out waiting for Max acknowledgement for scope "${plan.scope}"`
          )
        );
      }, this.applyTimeoutMs);

      const pending: PendingApply = {
        client,
        targetRevision: plan.targetRevision,
        resolve,
        reject,
        timeout,
      };
      this.pendingApplies.set(plan.scope, pending);

      client.send(JSON.stringify(plan), (error) => {
        if (!error) return;
        this.rejectPending(plan.scope, error);
      });
    });
  }

  async inspect(scope: string): Promise<MaxforgeSnapshotEvent> {
    const client = this.getSoleOpenClient();
    this.assertNoPendingOperation();
    const requestId = randomUUID();

    return new Promise<MaxforgeSnapshotEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectPendingInspection(
          new Error(
            `Timed out waiting for Max inspection of scope "${scope}"`
          )
        );
      }, this.applyTimeoutMs);
      this.pendingInspection = {
        client,
        requestId,
        scope,
        resolve,
        reject,
        timeout,
      };

      client.send(JSON.stringify({
        type: "maxforge.inspect.request",
        requestId,
        scope,
      }), (error) => {
        if (!error) return;
        this.rejectPendingInspection(error);
      });
    });
  }

  getLiveRevision(scope: string): string | null | undefined {
    return this.liveRevisions.get(scope);
  }

  getStatus(): MaxforgeBridgeStatus {
    const liveRevisions = Object.fromEntries(
      [...this.liveRevisions.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    );
    return {
      host: this.host,
      port: this.listeningPort ?? this.requestedPort,
      connectedClients: [...this.clients].filter(
        (client) => client.readyState === WebSocket.OPEN
      ).length,
      liveRevisions,
    };
  }

  private addClient(client: WebSocket): void {
    if (this.clients.size > 0) {
      this.rejectAllPending(
        new Error("An additional Max client connected during an operation")
      );
    }
    this.liveRevisions.clear();
    this.clients.add(client);
    client.on("message", (data) => this.handleMessage(client, data.toString()));
    client.on("close", () => {
      this.clients.delete(client);
      this.liveRevisions.clear();
      if (this.clients.size === 0) {
        this.rejectAllPending(new Error("Max client disconnected"));
      }
    });
    client.on("error", (error) => {
      if (this.clients.size <= 1) this.rejectAllPending(error);
    });
  }

  private handleMessage(client: WebSocket, raw: string): void {
    const event = parseBridgeEvent(raw);
    if (!event) return;

    if (event.type === "maxforge.revision") {
      this.liveRevisions.set(event.scope, event.revision);
      return;
    }

    if (event.type === "maxforge.snapshot") {
      this.handleSnapshot(client, event);
      return;
    }

    if (event.type === "maxforge.error" && this.pendingInspection) {
      this.rejectPendingInspection(
        new Error(
          `Max rejected inspection of scope ` +
          `"${this.pendingInspection.scope}": ${event.message}`
        )
      );
      return;
    }

    const pendingEntry = this.pendingApplies.entries().next().value as
      | [string, PendingApply]
      | undefined;
    if (!pendingEntry) {
      if (event.type === "maxforge.applied") {
        this.liveRevisions.set(event.scope, event.revision);
      }
      return;
    }
    const [pendingScope, pending] = pendingEntry;
    if (pending.client !== client) {
      this.rejectPending(
        pendingScope,
        new Error("Received acknowledgement from an unexpected Max client")
      );
      return;
    }

    if (event.type === "maxforge.error") {
      this.rejectPending(
        pendingScope,
        new Error(
          `Max rejected scope "${event.scope}" while applying ` +
          `"${pendingScope}": ${event.message}`
        )
      );
      return;
    }

    this.liveRevisions.set(event.scope, event.revision);
    if (pendingScope !== event.scope) {
      this.rejectPending(
        pendingScope,
        new Error(
          `Max acknowledged unexpected scope "${event.scope}" while applying ` +
          `"${pendingScope}"`
        )
      );
      return;
    }
    if (pending.targetRevision !== event.revision) {
      this.rejectPending(
        pendingScope,
        new Error(
          `Max acknowledged unexpected revision "${event.revision}" for scope "${event.scope}"`
        )
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingApplies.delete(pendingScope);
    pending.resolve(event);
  }

  private handleSnapshot(
    client: WebSocket,
    event: MaxforgeSnapshotEvent
  ): void {
    const pending = this.pendingInspection;
    if (!pending) return;
    if (pending.client !== client) {
      this.rejectPendingInspection(
        new Error("Received inspection result from an unexpected Max client")
      );
      return;
    }
    if (pending.requestId !== event.requestId) {
      this.rejectPendingInspection(
        new Error(
          `Max returned unexpected inspection request id "${event.requestId}"`
        )
      );
      return;
    }
    if (pending.scope !== event.scope) {
      this.rejectPendingInspection(
        new Error(
          `Max returned unexpected inspection scope "${event.scope}"`
        )
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingInspection = undefined;
    this.liveRevisions.set(event.scope, event.revision);
    pending.resolve(event);
  }

  private getSoleOpenClient(): WebSocket {
    if (!this.server || this.listeningPort === undefined) {
      throw new Error("WebSocket bridge is not started");
    }
    const openClients = [...this.clients].filter(
      (client) => client.readyState === WebSocket.OPEN
    );
    if (openClients.length !== 1) {
      throw new Error(
        `Exactly one Max client is required, connected: ${openClients.length}`
      );
    }
    return openClients[0];
  }

  private assertNoPendingOperation(): void {
    if (this.pendingApplies.size > 0) {
      const [pendingScope] = this.pendingApplies.keys();
      throw new Error(
        `An apply is already pending for scope "${pendingScope}"`
      );
    }
    if (this.pendingInspection) {
      throw new Error(
        `An inspection is already pending for scope ` +
        `"${this.pendingInspection.scope}"`
      );
    }
  }

  private rejectPending(scope: string, error: Error): void {
    const pending = this.pendingApplies.get(scope);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingApplies.delete(scope);
    pending.reject(error);
  }

  private rejectPendingInspection(error: Error): void {
    const pending = this.pendingInspection;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingInspection = undefined;
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const scope of this.pendingApplies.keys()) {
      this.rejectPending(scope, error);
    }
    this.rejectPendingInspection(error);
  }
}

export function parseBridgeEvent(raw: string): MaxforgeBridgeEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (typeof value.scope !== "string" || value.scope.length === 0) {
    return undefined;
  }

  if (
    value.type === "maxforge.applied" &&
    typeof value.revision === "string" &&
    REVISION_PATTERN.test(value.revision) &&
    typeof value.operations === "number" &&
    Number.isSafeInteger(value.operations) &&
    value.operations >= 0
  ) {
    return {
      type: value.type,
      scope: value.scope,
      revision: value.revision,
      operations: value.operations,
    };
  }

  if (
    value.type === "maxforge.revision" &&
    (value.revision === null ||
      (typeof value.revision === "string" &&
        REVISION_PATTERN.test(value.revision)))
  ) {
    return {
      type: value.type,
      scope: value.scope,
      revision: value.revision,
    };
  }

  if (
    value.type === "maxforge.error" &&
    typeof value.message === "string"
  ) {
    return {
      type: value.type,
      scope: value.scope,
      message: value.message,
    };
  }

  if (
    value.type === "maxforge.snapshot" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    (value.revision === null ||
      (typeof value.revision === "string" &&
        REVISION_PATTERN.test(value.revision)))
  ) {
    const patcher = parsePatcherSnapshot(value.patcher);
    if (!patcher) return undefined;
    return {
      type: value.type,
      requestId: value.requestId,
      scope: value.scope,
      revision: value.revision,
      patcher,
    };
  }

  return undefined;
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
    (value.text !== undefined && typeof value.text !== "string")
  ) {
    return undefined;
  }
  return {
    targetPath: value.targetPath,
    runtimeId: value.runtimeId,
    varName: value.varName,
    maxclass: value.maxclass,
    patchingRect: value.patchingRect,
    managed: value.managed,
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}

function parseSnapshotConnection(
  value: unknown
): MaxforgeSnapshotConnection | undefined {
  if (!isRecord(value) || !isStringArray(value.targetPath)) return undefined;
  const source = parseSnapshotEndpoint(value.source);
  const destination = parseSnapshotEndpoint(value.destination);
  if (!source || !destination) return undefined;
  return {
    targetPath: value.targetPath,
    source,
    destination,
  };
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
