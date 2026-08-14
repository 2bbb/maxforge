import { createServer, Server, Socket } from "node:net";
import { StdioServerHandle, StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  BrokerDescriptor,
  BrokerRequest,
  BrokerResponse,
  BrokerStatus,
  parseBrokerRequest,
} from "./broker-protocol.js";
import { createMaxforgeMcpRuntime, MaxforgeMcpRuntime } from "./runtime.js";

const MAX_HANDSHAKE_BYTES = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_POLL_INTERVAL_MS = 1000;

export interface MaxforgeBrokerOptions {
  readonly descriptor: BrokerDescriptor;
  readonly environment?: NodeJS.ProcessEnv;
  readonly idleTimeoutMs?: number;
  readonly createRuntime?: () => Promise<MaxforgeMcpRuntime>;
}

export class MaxforgeBroker {
  private readonly descriptor: BrokerDescriptor;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly idleTimeoutMs: number;
  private readonly createRuntime: () => Promise<MaxforgeMcpRuntime>;
  private readonly mcpSockets = new Set<Socket>();
  private readonly mcpHandles = new Map<Socket, StdioServerHandle>();
  private server: Server | undefined;
  private runtime: MaxforgeMcpRuntime | undefined;
  private runtimeError: string | undefined;
  private state: BrokerStatus["state"] = "starting";
  private idleSince = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: MaxforgeBrokerOptions) {
    this.descriptor = options.descriptor;
    this.environment = options.environment ?? process.env;
    this.idleTimeoutMs = options.idleTimeoutMs ?? idleTimeoutFromEnvironment(
      this.environment
    );
    if (!Number.isInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
      throw new Error("Broker idle timeout must be a non-negative integer");
    }
    this.createRuntime = options.createRuntime ?? (() =>
      createMaxforgeMcpRuntime(this.environment, () => this.getStatus()));
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Broker is already started");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const handleListening = () => {
        server.off("error", handleError);
        resolve();
      };
      const handleError = (error: Error) => {
        server.off("listening", handleListening);
        this.server = undefined;
        reject(error);
      };
      server.once("listening", handleListening);
      server.once("error", handleError);
      server.listen(this.descriptor.port, this.descriptor.host);
    });
    server.on("error", (error) => {
      this.runtimeError = error.message;
      this.state = "failed";
    });
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_POLL_INTERVAL_MS);
    this.idleTimer.unref();
    void this.initializeRuntime();
  }

  getStatus(): BrokerStatus {
    const bridgeStatus = this.runtime?.bridge.getStatus();
    return {
      state: this.state,
      brokerVersion: this.descriptor.clientVersion,
      pid: process.pid,
      mcpClients: this.mcpSockets.size,
      maxClients: bridgeStatus?.connectedClients ?? 0,
      pendingOperations: this.runtime?.bridge.getPendingOperationCount() ?? 0,
      idleTimeoutMs: this.idleTimeoutMs,
      ...(this.runtimeError ? { error: this.runtimeError } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal();
    return this.closing;
  }

  private async initializeRuntime(): Promise<void> {
    try {
      const runtime = await this.createRuntime();
      if (this.closing) {
        await runtime.close();
        return;
      }
      this.runtime = runtime;
      if (this.state !== "draining") this.state = "ready";
      this.runtimeError = undefined;
      this.markActivity();
    } catch (error) {
      this.runtimeError = error instanceof Error ? error.message : String(error);
      this.state = "failed";
    }
  }

  private accept(socket: Socket): void {
    let source = "";
    const handleData = (chunk: Buffer) => {
      source += chunk.toString("utf8");
      if (Buffer.byteLength(source) > MAX_HANDSHAKE_BYTES) {
        this.reject(socket, "INVALID_REQUEST", "Broker handshake is too large");
        return;
      }
      const newline = source.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", handleData);
      const trailing = source.slice(newline + 1);
      if (trailing.length > 0) {
        this.reject(
          socket,
          "INVALID_REQUEST",
          "MCP data was sent before the broker handshake completed"
        );
        return;
      }
      const request = parseBrokerRequest(source.slice(0, newline));
      if (!request) {
        this.reject(socket, "INVALID_REQUEST", "Invalid broker handshake");
        return;
      }
      this.handleRequest(socket, request);
    };
    socket.on("data", handleData);
    socket.once("error", () => socket.destroy());
  }

  private handleRequest(socket: Socket, request: BrokerRequest): void {
    if (request.key !== this.descriptor.key) {
      this.reject(socket, "WRONG_BROKER", "Broker project identity does not match");
      return;
    }
    if (
      request.configurationFingerprint !==
        this.descriptor.configurationFingerprint
    ) {
      this.reject(
        socket,
        "CONFIGURATION_MISMATCH",
        "Broker is already running with different Maxforge runtime settings"
      );
      return;
    }
    if (request.action === "status") {
      this.respondAndClose(socket, {
        protocol: this.descriptor.protocol,
        ok: true,
        key: this.descriptor.key,
        status: this.getStatus(),
      });
      return;
    }
    if (request.action === "stop") {
      this.handleStop(socket, request.force ?? false);
      return;
    }
    if (this.state === "starting") {
      this.reject(socket, "STARTING", "Broker runtime is still starting");
      return;
    }
    if (this.state !== "ready" || !this.runtime) {
      this.reject(
        socket,
        "UNAVAILABLE",
        this.runtimeError ?? "Broker runtime is unavailable"
      );
      return;
    }
    this.attachMcp(socket, this.runtime);
  }

  private handleStop(socket: Socket, force: boolean): void {
    const status = this.getStatus();
    if (status.pendingOperations > 0) {
      this.reject(
        socket,
        "BUSY",
        "Broker has pending operations; wait for them to settle before stopping"
      );
      return;
    }
    const busy = status.mcpClients > 0 || status.maxClients > 0;
    if (busy && !force) {
      this.reject(
        socket,
        "BUSY",
        "Broker still has MCP clients, Max clients, or pending operations"
      );
      return;
    }
    this.state = "draining";
    this.respondAndClose(socket, {
      protocol: this.descriptor.protocol,
      ok: true,
      key: this.descriptor.key,
      status: this.getStatus(),
    }, () => void this.close());
  }

  private attachMcp(socket: Socket, runtime: MaxforgeMcpRuntime): void {
    this.mcpSockets.add(socket);
    this.markActivity();
    const response: BrokerResponse = {
      protocol: this.descriptor.protocol,
      ok: true,
      key: this.descriptor.key,
      status: this.getStatus(),
    };
    socket.write(`${JSON.stringify(response)}\n`, () => {
      if (socket.destroyed) return;
      const transport = new StdioServerTransport(socket, socket);
      const handle = serveStdio(runtime.createServer, {
        transport,
        onerror: (error) => console.error(`maxforge broker MCP error: ${error.message}`),
      });
      this.mcpHandles.set(socket, handle);
    });
    socket.once("close", () => {
      this.mcpSockets.delete(socket);
      this.mcpHandles.delete(socket);
      this.markActivity();
    });
  }

  private reject(
    socket: Socket,
    code: Extract<BrokerResponse, { ok: false }>["code"],
    error: string
  ): void {
    this.respondAndClose(socket, {
      protocol: this.descriptor.protocol,
      ok: false,
      key: this.descriptor.key,
      code,
      error,
      status: this.getStatus(),
    });
  }

  private respondAndClose(
    socket: Socket,
    response: BrokerResponse,
    after?: () => void
  ): void {
    socket.end(`${JSON.stringify(response)}\n`, after);
  }

  private checkIdle(): void {
    const status = this.getStatus();
    if (
      status.mcpClients > 0 ||
      status.maxClients > 0 ||
      status.pendingOperations > 0
    ) {
      this.markActivity();
      return;
    }
    if (this.idleTimeoutMs <= Date.now() - this.idleSince) {
      void this.close();
    }
  }

  private markActivity(): void {
    this.idleSince = Date.now();
  }

  private async closeInternal(): Promise<void> {
    this.state = "draining";
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const handles = [...this.mcpHandles.values()];
    this.mcpHandles.clear();
    await Promise.allSettled(handles.map((handle) => handle.close()));
    for (const socket of this.mcpSockets) socket.destroy();
    this.mcpSockets.clear();
    if (this.runtime) await this.runtime.close();
    this.runtime = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

export function idleTimeoutFromEnvironment(
  environment: NodeJS.ProcessEnv
): number {
  const source = environment.MAXFORGE_BROKER_IDLE_MS;
  if (source === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(source);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("MAXFORGE_BROKER_IDLE_MS must be a non-negative integer");
  }
  return value;
}
