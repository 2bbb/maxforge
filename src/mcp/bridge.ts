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

export type MaxforgeBridgeEvent =
  | MaxforgeAppliedEvent
  | MaxforgeRevisionEvent
  | MaxforgeErrorEvent;

export interface MaxforgeBridgeStatus {
  readonly host: string;
  readonly port: number;
  readonly connectedClients: number;
  readonly liveRevisions: Readonly<Record<string, string | null>>;
}

export interface PatchPlanTransport {
  apply(plan: PatchPlan): Promise<MaxforgeAppliedEvent>;
  getLiveRevision(scope: string): string | null | undefined;
  getStatus(): MaxforgeBridgeStatus;
}

export interface MaxforgeBridgeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly applyTimeoutMs?: number;
}

interface PendingApply {
  readonly targetRevision: string;
  readonly resolve: (event: MaxforgeAppliedEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

const REVISION_PATTERN = /^[a-f0-9]{64}$/;

export class MaxforgeWebSocketBridge implements PatchPlanTransport {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly applyTimeoutMs: number;
  private readonly clients = new Set<WebSocket>();
  private readonly pendingApplies = new Map<string, PendingApply>();
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

    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async apply(plan: PatchPlan): Promise<MaxforgeAppliedEvent> {
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
    if (this.pendingApplies.has(plan.scope)) {
      throw new Error(`An apply is already pending for scope "${plan.scope}"`);
    }

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
        targetRevision: plan.targetRevision,
        resolve,
        reject,
        timeout,
      };
      this.pendingApplies.set(plan.scope, pending);

      openClients[0].send(JSON.stringify(plan), (error) => {
        if (!error) return;
        this.rejectPending(plan.scope, error);
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
    this.clients.add(client);
    client.on("message", (data) => this.handleMessage(data.toString()));
    client.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0) {
        this.rejectAllPending(new Error("Max client disconnected"));
      }
    });
    client.on("error", (error) => {
      if (this.clients.size <= 1) this.rejectAllPending(error);
    });
  }

  private handleMessage(raw: string): void {
    const event = parseBridgeEvent(raw);
    if (!event) return;

    if (event.type === "maxforge.revision") {
      this.liveRevisions.set(event.scope, event.revision);
      return;
    }

    if (event.type === "maxforge.error") {
      this.rejectPending(
        event.scope,
        new Error(`Max rejected scope "${event.scope}": ${event.message}`)
      );
      return;
    }

    this.liveRevisions.set(event.scope, event.revision);
    const pending = this.pendingApplies.get(event.scope);
    if (!pending) return;
    if (pending.targetRevision !== event.revision) {
      this.rejectPending(
        event.scope,
        new Error(
          `Max acknowledged unexpected revision "${event.revision}" for scope "${event.scope}"`
        )
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingApplies.delete(event.scope);
    pending.resolve(event);
  }

  private rejectPending(scope: string, error: Error): void {
    const pending = this.pendingApplies.get(scope);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingApplies.delete(scope);
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const scope of this.pendingApplies.keys()) {
      this.rejectPending(scope, error);
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

  return undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
