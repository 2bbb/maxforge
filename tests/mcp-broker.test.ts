import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokerDescriptorFromEnvironment } from "../src/mcp/broker-protocol.js";
import { requestBroker } from "../src/mcp/broker-client.js";

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
      });
      expect(status.broker.error).toMatch(/EADDRINUSE|address already in use/i);
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  });
});

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

  constructor(environment: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [resolve("dist/mcp/bin.js")], {
      cwd: resolve("."),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
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
