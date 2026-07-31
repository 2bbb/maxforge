#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadDatabase } from "../core/object-db.js";
import { MaxforgeWebSocketBridge } from "./bridge.js";
import { createMaxforgeMcpServer } from "./mcp-server.js";
import { MaxforgePatchService } from "./service.js";

export async function main(): Promise<void> {
  const bridge = new MaxforgeWebSocketBridge({
    host: process.env.MAXFORGE_WS_HOST ?? "127.0.0.1",
    port: integerEnvironment("MAXFORGE_WS_PORT", 8766),
    applyTimeoutMs: integerEnvironment("MAXFORGE_APPLY_TIMEOUT_MS", 5000),
  });
  const status = await bridge.start();
  const service = new MaxforgePatchService(await loadDatabase(), bridge);
  const version = await packageVersion();
  const handle = serveStdio(() =>
    createMaxforgeMcpServer({ service, transport: bridge, version })
  );

  console.error(
    `maxforge MCP listening for Max on ws://${status.host}:${status.port}`
  );

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    await Promise.allSettled([handle.close(), bridge.close()]);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

async function packageVersion(): Promise<string> {
  const packageUrl = new URL("../../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
    version?: unknown;
  };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

const executablePath = process.argv[1]
  ? resolve(process.argv[1])
  : undefined;
if (
  executablePath &&
  resolve(fileURLToPath(import.meta.url)) === executablePath
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
