import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BROKER_PROTOCOL, BrokerDescriptor } from "../src/mcp/broker-protocol.js";
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
