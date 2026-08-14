import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BROKER_PROTOCOL, BrokerDescriptor } from "../src/mcp/broker-protocol.js";
import {
  ensureBrokerConnection,
  requestBroker,
} from "../src/mcp/broker-client.js";
import { MaxforgeBroker } from "../src/mcp/broker.js";
import type { MaxforgeMcpRuntime } from "../src/mcp/runtime.js";

describe("MaxforgeBroker lifecycle", () => {
  it("retains project ownership until an in-progress runtime startup is closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-broker-close-"));
    const leasePath = join(directory, "owner.lock");
    const closeRuntime = vi.fn(async () => undefined);
    let resolveRuntime!: (runtime: MaxforgeMcpRuntime) => void;
    const runtime = new Promise<MaxforgeMcpRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const descriptor: BrokerDescriptor = {
      protocol: BROKER_PROTOCOL,
      key: "project:close_during_startup",
      host: "127.0.0.1",
      port: await freePort(),
      ownerPort: await freePort(),
      clientVersion: "test",
      configurationFingerprint: "test",
      ownerLeasePath: leasePath,
    };
    const broker = new MaxforgeBroker({
      descriptor,
      idleTimeoutMs: 5000,
      createRuntime: () => runtime,
    });

    try {
      await broker.start();
      expect(existsSync(leasePath)).toBe(true);
      const closing = broker.close();
      await Promise.resolve();
      expect(existsSync(leasePath)).toBe(true);

      resolveRuntime({
        bridge: {} as MaxforgeMcpRuntime["bridge"],
        service: {} as MaxforgeMcpRuntime["service"],
        version: "test",
        createServer: vi.fn() as MaxforgeMcpRuntime["createServer"],
        getCatalog: vi.fn() as MaxforgeMcpRuntime["getCatalog"],
        close: closeRuntime,
      });
      await closing;
      expect(closeRuntime).toHaveBeenCalledOnce();
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      await broker.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a diagnostic control endpoint when project ownership is busy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-broker-owner-busy-"));
    const ownerPort = await freePort();
    const blocker = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(ownerPort, "127.0.0.1", resolve);
    });
    const broker = new MaxforgeBroker({
      descriptor: {
        protocol: BROKER_PROTOCOL,
        key: "project:owner_busy",
        host: "127.0.0.1",
        port: await freePort(),
        ownerPort,
        clientVersion: "test",
        configurationFingerprint: "test",
        ownerLeasePath: join(directory, "owner.lock"),
      },
      idleTimeoutMs: 5000,
      createRuntime: vi.fn(),
    });

    try {
      await broker.start();
      expect(broker.getStatus()).toMatchObject({
        state: "failed",
        ownerPort,
        ownership: { state: "unlocked" },
        error: expect.stringContaining("Project ownership endpoint"),
      });
    } finally {
      await broker.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps status and stop available across frontend version changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-broker-control-"));
    const closeRuntime = vi.fn(async () => undefined);
    const descriptor: BrokerDescriptor = {
      protocol: BROKER_PROTOCOL,
      key: "project:cross_version_control",
      host: "127.0.0.1",
      port: await freePort(),
      ownerPort: await freePort(),
      clientVersion: "broker-version",
      configurationFingerprint: "broker-settings",
      ownerLeasePath: join(directory, "owner.lock"),
    };
    const broker = new MaxforgeBroker({
      descriptor,
      idleTimeoutMs: 5000,
      createRuntime: async () => ({
        bridge: {
          getStatus: () => ({ connectedClients: 0 }),
          getPendingOperationCount: () => 0,
        } as MaxforgeMcpRuntime["bridge"],
        service: {} as MaxforgeMcpRuntime["service"],
        version: "broker-version",
        createServer: vi.fn() as MaxforgeMcpRuntime["createServer"],
        getCatalog: vi.fn() as MaxforgeMcpRuntime["getCatalog"],
        close: closeRuntime,
      }),
    });
    const newerFrontend = {
      ...descriptor,
      clientVersion: "newer-frontend",
      configurationFingerprint: "newer-settings",
    };

    try {
      await broker.start();
      await waitFor(() => broker.getStatus().state === "ready");
      await expect(ensureBrokerConnection(newerFrontend, {
        MAXFORGE_BROKER_START_TIMEOUT_MS: "500",
      })).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
      const status = await requestBroker(newerFrontend, "status");
      expect(status.status).toMatchObject({
        state: "ready",
        brokerVersion: "broker-version",
        ownership: { state: "owned" },
      });

      const stopped = await requestBroker(newerFrontend, "stop");
      expect(stopped.status.state).toBe("draining");
      await broker.close();
      expect(closeRuntime).toHaveBeenCalledOnce();
    } finally {
      await broker.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a localhost test port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for broker state");
}
