#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadObjectCatalog } from "../core/catalog-config.js";
import { MaxforgeWebSocketBridge } from "./bridge.js";
import { createMaxforgeMcpServer } from "./mcp-server.js";
import { MaxforgePatchService } from "./service.js";
import { DslPatchAdapter } from "./dsl-patch-adapter.js";
import {
  JsonFilePatchStateStore,
  stateFileFromEnvironment,
} from "./state-store.js";
import {
  editHistoryDirectoryFromEnvironment,
  editHistoryOptionsFromEnvironment,
  JsonLinesEditHistoryStore,
} from "./edit-history-store.js";

export function bridgeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv
): ConstructorParameters<typeof MaxforgeWebSocketBridge>[0] {
  const token = optionalEnvironment(environment, "MAXFORGE_WS_TOKEN");
  return {
    host: environment.MAXFORGE_WS_HOST ?? (token ? "0.0.0.0" : "127.0.0.1"),
    port: integerEnvironment(environment, "MAXFORGE_WS_PORT", 8766),
    token,
    applyTimeoutMs: integerEnvironment(
      environment,
      "MAXFORGE_APPLY_TIMEOUT_MS",
      5000
    ),
  };
}

export function catalogOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv
): Parameters<typeof loadObjectCatalog>[0] {
  return {
    configPath: optionalEnvironment(environment, "MAXFORGE_CONFIG"),
    discover: false,
  };
}

export async function main(): Promise<void> {
  const catalogOptions = catalogOptionsFromEnvironment(process.env);
  const [catalog, version] = await Promise.all([
    loadObjectCatalog(catalogOptions),
    packageVersion(),
  ]);
  const bridgeOptions = bridgeOptionsFromEnvironment(process.env);
  const editHistoryDirectory = editHistoryDirectoryFromEnvironment(
    process.env,
    catalog.project
  );
  const editHistoryStore = editHistoryDirectory && catalog.project
    ? new JsonLinesEditHistoryStore(editHistoryOptionsFromEnvironment(
      process.env,
      catalog.project,
      editHistoryDirectory
    ))
    : undefined;
  const bridge = new MaxforgeWebSocketBridge(bridgeOptions, editHistoryStore);
  const status = await bridge.start();
  const stateFile = stateFileFromEnvironment(
    process.env,
    status.port,
    catalog.project?.id
  );
  const stateStore = stateFile
    ? new JsonFilePatchStateStore(stateFile)
    : undefined;
  const patchAdapter = new DslPatchAdapter(catalog.database);
  const service = new MaxforgePatchService(
    patchAdapter,
    bridge,
    stateStore,
    editHistoryStore
  );
  let handle;
  try {
    handle = serveStdio(() =>
      createMaxforgeMcpServer({
        service,
        transport: bridge,
        version,
        catalog,
        replaceObjectDatabase: (database) =>
          patchAdapter.replaceDatabase(database),
        reloadCatalog: () => loadObjectCatalog(catalogOptions),
      })
    );
  } catch (error) {
    await bridge.close();
    throw error;
  }

  console.error(
    `maxforge MCP listening for Max on ws://${status.host}:${status.port}`
  );
  console.error(
    editHistoryStore
      ? `maxforge persists edit history in ${editHistoryStore.directory}`
      : catalog.project
        ? "maxforge edit-history persistence is disabled"
        : "maxforge edit-history persistence requires project.id in MAXFORGE_CONFIG"
  );
  if (catalog.configPath) {
    console.error(
      `maxforge loaded ${catalog.customObjects.length} custom objects from ` +
      catalog.configPath
    );
  }
  console.error(
    stateStore
      ? `maxforge persists MCP state in ${stateStore.path}`
      : "maxforge MCP state persistence is disabled"
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

function optionalEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = environment[name];
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
