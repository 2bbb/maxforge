import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrokerDescriptor,
  brokerDescriptorFromEnvironment,
} from "../src/mcp/broker-protocol.js";
import {
  ensureBrokerConnection,
  requestBroker,
} from "../src/mcp/broker-client.js";
import { MaxforgeBroker } from "../src/mcp/broker.js";
import type { MaxforgeMcpRuntime } from "../src/mcp/runtime.js";

const children: McpChild[] = [];
const temporaryDirectories: string[] = [];
const brokerEnvironments: NodeJS.ProcessEnv[] = [];

afterEach(async () => {
  await Promise.allSettled(children.splice(0).map((child) => child.close()));
  for (const environment of brokerEnvironments.splice(0)) {
    try {
      const descriptor = await brokerDescriptorFromEnvironment(environment);
      await requestBroker(descriptor, "stop", true);
    } catch {
      // The broker may already have exited through its idle policy.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("maxforge project broker", () => {
  it("shares one owner, survives the first frontend, and exits only when idle", async () => {
    const environment = await brokerEnvironment(200);
    const first = startMcp(environment);
    await first.initialize();
    const second = startMcp(environment);
    await second.initialize();

    const shared = await second.status();
    expect(shared.broker).toMatchObject({
      state: "ready",
      mcpClients: 2,
      maxClients: 0,
      pendingOperations: 0,
      idleTimeoutMs: 200,
    });
    const brokerPid = shared.broker.pid;

    await first.close();
    await waitFor(async () => (await second.status()).broker.mcpClients === 1);
    expect((await second.status()).broker.pid).toBe(brokerPid);

    const leasePath = join(environment.MAXFORGE_EDIT_HISTORY_DIR!, "writer-v1.lock");
    expect(existsSync(leasePath)).toBe(true);
    await second.close();

    const descriptor = await brokerDescriptorFromEnvironment(environment);
    await waitFor(async () => {
      try {
        await requestBroker(descriptor, "status");
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
      }
    }, 3000);
    expect(existsSync(leasePath)).toBe(false);
  });

  it("recovers a dead broker lease without displacing a live owner", async () => {
    const environment = await brokerEnvironment(5000);
    const first = startMcp(environment);
    await first.initialize();
    const status = await first.status();
    const deadPid = status.broker.pid as number;
    const leasePath = join(environment.MAXFORGE_EDIT_HISTORY_DIR!, "writer-v1.lock");

    process.kill(deadPid, "SIGKILL");
    await waitFor(async () => {
      try {
        process.kill(deadPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    expect(existsSync(leasePath)).toBe(true);
    await first.close();

    const recovered = startMcp(environment);
    await recovered.initialize();
    const recoveredStatus = await recovered.status();
    expect(recoveredStatus.broker).toMatchObject({ state: "ready" });
    expect(recoveredStatus.broker.pid).not.toBe(deadPid);
    expect(JSON.parse(readFileSync(leasePath, "utf8"))).toMatchObject({
      pid: recoveredStatus.broker.pid,
    });

    const second = startMcp(environment);
    await second.initialize();
    expect((await second.status()).broker.pid).toBe(recoveredStatus.broker.pid);
  });

  it("keeps one project owner even when a frontend selects another broker port", async () => {
    const environment = await brokerEnvironment(5000);
    const owner = startMcp(environment);
    await owner.initialize();
    const ownerPid = (await owner.status()).broker.pid;
    const alternate = {
      ...environment,
      MAXFORGE_BROKER_PORT: String(await freePort()),
    };
    brokerEnvironments.push(alternate);

    const contender = startMcp(alternate);
    await contender.initialize();
    const unavailable = await contender.status();
    expect(unavailable.broker).toMatchObject({ state: "unavailable" });
    expect(unavailable.broker.error).toContain("Project ownership endpoint");
    expect(unavailable.broker.code).toBe("UNAVAILABLE");
    expect(unavailable.broker.brokerStatus.ownership).toMatchObject({
      state: "held_by_other_process",
      pid: ownerPid,
    });
    expect((await owner.status()).broker.pid).toBe(ownerPid);
  });

  it("rejects an MCP frontend from a different package version", async () => {
    const environment = await brokerEnvironment(5000);
    const owner = startMcp(environment);
    await owner.initialize();
    const descriptor = await brokerDescriptorFromEnvironment(environment);

    await expect(ensureBrokerConnection({
      ...descriptor,
      clientVersion: "99.0.0-test",
    }, environment)).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    expect((await owner.status()).broker).toMatchObject({
      pid: expect.any(Number),
      brokerVersion: descriptor.clientVersion,
    });
  });

  it("refreshes a startup version mismatch after the broker is replaced", async () => {
    const environment = await brokerEnvironment(5000);
    const descriptor = await brokerDescriptorFromEnvironment(environment);
    const oldBroker = await startLegacyMismatchBroker(descriptor);
    let replacement: MaxforgeBroker | undefined;

    try {
      const frontend = startMcp(environment);
      await frontend.initialize();
      expect((await frontend.status()).broker).toMatchObject({
        state: "unavailable",
        code: "VERSION_MISMATCH",
        brokerStatus: {
          brokerVersion: "older-broker",
          pid: oldBroker.pid,
        },
      });
      expect((await frontend.status()).broker).toMatchObject({
        state: "unavailable",
        code: "VERSION_MISMATCH",
      });
      expect(oldBroker.actions).toEqual(["mcp", "status", "status"]);

      await oldBroker.close();
      expect((await frontend.status()).broker).toMatchObject({
        state: "unavailable",
        code: null,
        brokerStatus: null,
        error: expect.stringMatching(/ECONNREFUSED|connect/i),
      });

      replacement = testBroker(descriptor);
      await replacement.start();
      await waitFor(() => replacement?.getStatus().state === "ready");

      for (let index = 0; index < 2; index += 1) {
        expect((await frontend.status()).broker).toMatchObject({
          state: "unavailable",
          code: "RECONNECT_REQUIRED",
          brokerStatus: {
            brokerVersion: descriptor.clientVersion,
            pid: replacement.getStatus().pid,
            mcpClients: 0,
          },
        });
        expect(replacement.getStatus().mcpClients).toBe(0);
      }
    } finally {
      await replacement?.close().catch(() => undefined);
      await oldBroker.close();
    }
  });

  it("still initializes MCP and reports a degraded status when bridge startup fails", async () => {
    const environment = await brokerEnvironment(5000);
    const blockedPort = Number(environment.MAXFORGE_WS_PORT);
    const blocker = createServer();
    await new Promise<void>((resolveListen, reject) => {
      blocker.once("error", reject);
      blocker.listen(blockedPort, "127.0.0.1", resolveListen);
    });

    try {
      const client = startMcp(environment);
      await expect(client.initialize()).resolves.toMatchObject({
        result: { serverInfo: { name: "maxforge" } },
      });
      const status = await client.status();
      expect(status.broker).toMatchObject({
        state: "unavailable",
        port: Number(environment.MAXFORGE_BROKER_PORT),
        code: "UNAVAILABLE",
      });
      expect(status.broker.error).toMatch(/EADDRINUSE|address already in use/i);
      expect(await client.toolNames()).toEqual(["maxforge_status"]);
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  });

  it("refreshes a startup failure after the failed broker is replaced", async () => {
    const environment = await brokerEnvironment(5000);
    const descriptor = await brokerDescriptorFromEnvironment(environment);
    const blocker = createServer();
    await listen(blocker, Number(environment.MAXFORGE_WS_PORT));
    let replacement: MaxforgeBroker | undefined;

    try {
      const frontend = startMcp(environment);
      await frontend.initialize();
      expect((await frontend.status()).broker).toMatchObject({
        state: "unavailable",
        code: "UNAVAILABLE",
        error: expect.stringMatching(/EADDRINUSE|address already in use/i),
      });

      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
      await requestBroker(descriptor, "stop", true);
      await waitFor(async () => {
        try {
          await requestBroker(descriptor, "status");
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
        }
      });

      replacement = testBroker(descriptor);
      await replacement.start();
      await waitFor(() => replacement?.getStatus().state === "ready");

      expect((await frontend.status()).broker).toMatchObject({
        state: "unavailable",
        code: "RECONNECT_REQUIRED",
        brokerStatus: {
          brokerVersion: descriptor.clientVersion,
          pid: replacement.getStatus().pid,
          mcpClients: 0,
        },
      });
      expect(await frontend.toolNames()).toEqual(["maxforge_status"]);
    } finally {
      if (blocker.listening) {
        await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
      }
      await replacement?.close().catch(() => undefined);
    }
  });

  it("refuses an implicit upgrade while busy and performs an explicit forced restart", async () => {
    const environment = await brokerEnvironment(5000);
    const client = startMcp(environment);
    await client.initialize();
    const originalPid = (await client.status()).broker.pid;

    const refused = await runCli(["broker", "restart", "--config", environment.MAXFORGE_CONFIG!], environment);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("BUSY");
    expect((await client.status()).broker.pid).toBe(originalPid);

    const restarted = await runCli([
      "broker",
      "restart",
      "--config",
      environment.MAXFORGE_CONFIG!,
      "--force",
    ], environment);
    expect(restarted).toMatchObject({ code: 0, stderr: "" });
    const restartStatus = JSON.parse(restarted.stdout);
    expect(restartStatus).toMatchObject({ state: "ready" });
    expect(restartStatus.pid).not.toBe(originalPid);
    expect(await client.waitForExit()).toMatchObject({ code: 1, signal: null });

    const reconnected = startMcp(environment);
    await reconnected.initialize();
    expect((await reconnected.status()).broker.pid).toBe(restartStatus.pid);
  });
});

function testBroker(descriptor: BrokerDescriptor): MaxforgeBroker {
  return new MaxforgeBroker({
    descriptor,
    idleTimeoutMs: 5000,
    createRuntime: async () => ({
      bridge: {
        getStatus: () => ({ connectedClients: 0 }),
        getPendingOperationCount: () => 0,
      } as MaxforgeMcpRuntime["bridge"],
      service: {} as MaxforgeMcpRuntime["service"],
      version: descriptor.clientVersion,
      createServer: vi.fn() as MaxforgeMcpRuntime["createServer"],
      getCatalog: vi.fn() as MaxforgeMcpRuntime["getCatalog"],
      close: async () => undefined,
    }),
  });
}

async function startLegacyMismatchBroker(
  descriptor: BrokerDescriptor
): Promise<{ pid: number; actions: string[]; close: () => Promise<void> }> {
  const pid = process.pid + 100_000;
  const actions: string[] = [];
  const status = {
    state: "ready" as const,
    brokerVersion: "older-broker",
    pid,
    mcpClients: 0,
    maxClients: 0,
    pendingOperations: 0,
    idleTimeoutMs: 5000,
    ownerPort: descriptor.ownerPort,
    ownership: {
      state: "owned" as const,
      path: descriptor.ownerLeasePath,
      identity: descriptor.key,
      pid,
      acquiredAt: new Date(0).toISOString(),
    },
  };
  const server = createServer((socket) => {
    let source = "";
    socket.on("data", (chunk: Buffer) => {
      source += chunk.toString("utf8");
      const newline = source.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(source.slice(0, newline)) as { action?: string };
      actions.push(request.action ?? "missing");
      if (request.action === "status") {
        socket.end(`${JSON.stringify({
          protocol: descriptor.protocol,
          ok: true,
          key: descriptor.key,
          status,
        })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({
        protocol: descriptor.protocol,
        ok: false,
        key: descriptor.key,
        code: request.action === "mcp"
          ? "VERSION_MISMATCH"
          : "INVALID_REQUEST",
        error: request.action === "mcp"
          ? `Frontend ${descriptor.clientVersion} cannot attach to broker older-broker`
          : "Invalid broker handshake",
        status,
      })}\n`);
    });
  });
  await listen(server, descriptor.port);
  return {
    pid,
    actions,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

async function brokerEnvironment(idleTimeoutMs: number): Promise<NodeJS.ProcessEnv> {
  const directory = mkdtempSync(join(tmpdir(), "maxforge-broker-test-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "maxforge.config.json");
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    project: { id: `broker_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
  }));
  const environment = {
    ...process.env,
    MAXFORGE_CONFIG: configPath,
    MAXFORGE_BROKER_PORT: String(await freePort()),
    MAXFORGE_WS_PORT: String(await freePort()),
    MAXFORGE_BROKER_IDLE_MS: String(idleTimeoutMs),
    MAXFORGE_BROKER_START_TIMEOUT_MS: "5000",
    MAXFORGE_BROKER_DIR: join(directory, "broker"),
    MAXFORGE_EDIT_HISTORY_DIR: join(directory, "history"),
    MAXFORGE_STATE_FILE: join(directory, "state.json"),
  };
  brokerEnvironments.push(environment);
  return environment;
}

function startMcp(environment: NodeJS.ProcessEnv): McpChild {
  const child = new McpChild(environment);
  children.push(child);
  return child;
}

class McpChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, {
    resolve: (message: Record<string, any>) => void;
    reject: (error: Error) => void;
  }>();
  private stdout = "";
  private stderr = "";
  private nextId = 1;
  private closed = false;
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(environment: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [resolve("dist/mcp/bin.js")], {
      cwd: resolve("."),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolveExit) => {
      this.child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.once("exit", (code, signal) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(
          `maxforge-mcp exited (code=${String(code)}, signal=${String(signal)}): ` +
          this.stderr.trim()
        ));
      }
      this.pending.clear();
    });
  }

  initialize(): Promise<Record<string, any>> {
    return this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "maxforge-broker-test", version: "1.0.0" },
    });
  }

  async status(): Promise<Record<string, any>> {
    const response = await this.request("tools/call", {
      name: "maxforge_status",
      arguments: {},
    });
    return response.result.structuredContent;
  }

  async toolNames(): Promise<string[]> {
    const response = await this.request("tools/list", {});
    return response.result.tools.map(({ name }: { name: string }) => name);
  }

  async waitForExit(timeoutMs = 5000): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    return new Promise((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for MCP frontend exit"));
      }, timeoutMs);
      this.exited.then((result) => {
        clearTimeout(timeout);
        resolveExit(result);
      });
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++;
    return new Promise((resolveResponse, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out: ${this.stderr.trim()}`));
      }, 5000);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timeout);
          resolveResponse(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise<void>((resolveExit) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolveExit();
        return;
      }
      const timeout = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolveExit();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
  }

  private receive(chunk: Buffer): void {
    this.stdout += chunk.toString();
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, any>;
      const id = message.id;
      if (typeof id !== "number") continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      pending.resolve(message);
    }
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a localhost test port");
  }
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function runCli(
  arguments_: string[],
  environment: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve("dist/cli/index.js"), ...arguments_], {
      cwd: resolve("."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveRun({
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }));
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for broker state");
}
