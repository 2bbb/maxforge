import { spawn } from "node:child_process";
import { Socket, createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  BrokerAction,
  BrokerDescriptor,
  BrokerRequest,
  BrokerResponse,
  brokerDescriptorFromEnvironment,
} from "./broker-protocol.js";
import { packageVersion } from "./runtime.js";

const CONNECT_TIMEOUT_MS = 5000;
const CONNECT_RETRY_MS = 50;
const HANDSHAKE_TIMEOUT_MS = 1000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;

export interface BrokerConnection {
  readonly socket: Socket;
  readonly response: Extract<BrokerResponse, { ok: true }>;
}

type BrokerFailureResponse = Extract<BrokerResponse, { ok: false }>;

class BrokerRequestError extends Error {
  readonly code: BrokerFailureResponse["code"];

  constructor(readonly response: BrokerFailureResponse) {
    super(`${response.code}: ${response.error}`);
    this.name = "BrokerRequestError";
    this.code = response.code;
  }
}

export async function runMcpFrontend(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let descriptor: BrokerDescriptor | undefined;
  try {
    descriptor = await brokerDescriptorFromEnvironment(environment);
    const connection = await ensureBrokerConnection(descriptor, environment);
    proxyStdio(connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`maxforge MCP broker unavailable: ${message}`);
    serveUnavailableMcp(
      descriptor,
      message,
      await packageVersion(),
      error instanceof BrokerRequestError ? error.response : undefined
    );
  }
}

export async function ensureBrokerConnection(
  descriptor: BrokerDescriptor,
  environment: NodeJS.ProcessEnv = process.env
): Promise<BrokerConnection> {
  const deadline = Date.now() + timeoutFromEnvironment(environment);
  let spawned = false;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const connection = await connectToBroker(descriptor, "mcp");
      if (connection.response.ok) return connection as BrokerConnection;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!spawned && isConnectionRefused(lastError)) {
        spawnBroker(environment);
        spawned = true;
      } else if (!isRetryable(lastError)) {
        throw lastError;
      }
    }
    await delay(CONNECT_RETRY_MS);
  }
  throw lastError ?? new Error("Timed out waiting for maxforge broker");
}

export async function requestBroker(
  descriptor: BrokerDescriptor,
  action: Exclude<BrokerAction, "mcp">,
  force = false
): Promise<Extract<BrokerResponse, { ok: true }>> {
  const { socket, response } = await connectToBroker(
    descriptor,
    action,
    force
  );
  socket.destroy();
  return response;
}

export function spawnBroker(environment: NodeJS.ProcessEnv = process.env): void {
  const entrypoint = fileURLToPath(new URL("./broker-bin.js", import.meta.url));
  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    env: { ...environment },
    stdio: "ignore",
  });
  child.unref();
}

async function connectToBroker(
  descriptor: BrokerDescriptor,
  action: BrokerAction,
  force = false
): Promise<{
  socket: Socket;
  response: Extract<BrokerResponse, { ok: true }>;
}> {
  const socket = createConnection({
    host: descriptor.host,
    port: descriptor.port,
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out connecting to maxforge broker"));
    }, HANDSHAKE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const request: BrokerRequest = { ...descriptor, action, ...(force ? { force } : {}) };
  socket.write(`${JSON.stringify(request)}\n`);
  const response = await readHandshake(socket);
  if (!response.ok) {
    socket.destroy();
    throw new BrokerRequestError(response);
  }
  return { socket, response };
}

function readHandshake(socket: Socket): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    let source = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for maxforge broker handshake"));
    }, HANDSHAKE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", handleData);
      socket.off("close", handleClose);
      socket.off("error", handleError);
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Maxforge broker closed during handshake"));
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleData = (chunk: Buffer) => {
      source += chunk.toString("utf8");
      if (Buffer.byteLength(source) > MAX_HANDSHAKE_BYTES) {
        cleanup();
        reject(new Error("Maxforge broker handshake is too large"));
        return;
      }
      const newline = source.indexOf("\n");
      if (newline < 0) return;
      if (source.slice(newline + 1).length > 0) {
        cleanup();
        reject(new Error("Maxforge broker sent MCP data before handshake completion"));
        return;
      }
      try {
        const response = JSON.parse(source.slice(0, newline)) as BrokerResponse;
        cleanup();
        resolve(response);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    socket.on("data", handleData);
    socket.once("close", handleClose);
    socket.once("error", handleError);
  });
}

function proxyStdio(connection: BrokerConnection): void {
  const { socket, response } = connection;
  console.error(
    `maxforge MCP connected to broker ${response.status.brokerVersion} ` +
    `(pid ${response.status.pid})`
  );
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    process.stdin.unpipe(socket);
    socket.end();
  };
  process.stdin.once("end", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  socket.once("error", (error) => {
    console.error(`maxforge MCP broker connection failed: ${error.message}`);
  });
  socket.once("close", () => {
    process.stdin.unpipe(socket);
    process.stdin.pause();
    if (!closing) process.exitCode = 1;
  });
}

function serveUnavailableMcp(
  descriptor: BrokerDescriptor | undefined,
  error: string,
  version: string,
  failure?: BrokerFailureResponse
): void {
  const ownershipSchema = z.object({
    state: z.enum([
      "unlocked",
      "owned",
      "held_by_other_process",
      "stale",
      "malformed",
    ]),
    path: z.string(),
    identity: z.string().nullable(),
    pid: z.number().int().positive().nullable(),
    acquiredAt: z.string().nullable(),
  });
  const brokerStatusSchema = z.object({
    state: z.enum(["starting", "ready", "failed", "draining"]),
    brokerVersion: z.string(),
    pid: z.number().int().positive(),
    mcpClients: z.number().int().nonnegative(),
    maxClients: z.number().int().nonnegative(),
    pendingOperations: z.number().int().nonnegative(),
    idleTimeoutMs: z.number().int().nonnegative(),
    ownerPort: z.number().int().min(1024).max(65535),
    error: z.string().optional(),
    ownership: ownershipSchema,
  });
  const server = new McpServer({ name: "maxforge", version });
  server.registerTool(
    "maxforge_status",
    {
      title: "Maxforge status",
      description: "Report why the project broker could not serve this MCP session.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        broker: z.object({
          state: z.literal("unavailable"),
          key: z.string().nullable(),
          host: z.string().nullable(),
          port: z.number().int().nullable(),
          error: z.string(),
          code: z.string().nullable(),
          brokerStatus: brokerStatusSchema.nullable(),
        }),
      }),
    },
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          broker: {
            state: "unavailable",
            key: descriptor?.key ?? null,
            host: descriptor?.host ?? null,
            port: descriptor?.port ?? null,
            error,
            code: failure?.code ?? null,
            brokerStatus: failure?.status ?? null,
          },
        }, null, 2),
      }],
      structuredContent: {
        broker: {
          state: "unavailable" as const,
          key: descriptor?.key ?? null,
          host: descriptor?.host ?? null,
          port: descriptor?.port ?? null,
          error,
          code: failure?.code ?? null,
          brokerStatus: failure?.status ?? null,
        },
      },
    })
  );
  serveStdio(() => server);
}

function timeoutFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const source = environment.MAXFORGE_BROKER_START_TIMEOUT_MS;
  if (source === undefined) return CONNECT_TIMEOUT_MS;
  const value = Number(source);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("MAXFORGE_BROKER_START_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

function isConnectionRefused(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
}

function isRetryable(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNREFUSED" || code === "STARTING" ||
    error.message.includes("closed during handshake");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
