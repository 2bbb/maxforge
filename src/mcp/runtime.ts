import { readFile } from "node:fs/promises";
import { loadObjectCatalog, LoadedObjectCatalog } from "../core/catalog-config.js";
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
import type { BrokerStatus } from "./broker-protocol.js";

export interface MaxforgeMcpRuntime {
  readonly bridge: MaxforgeWebSocketBridge;
  readonly service: MaxforgePatchService;
  readonly version: string;
  readonly stateStore?: JsonFilePatchStateStore;
  readonly editHistoryStore?: JsonLinesEditHistoryStore;
  readonly createServer: () => ReturnType<typeof createMaxforgeMcpServer>;
  readonly getCatalog: () => LoadedObjectCatalog;
  close(): Promise<void>;
}

export function bridgeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv
): NonNullable<ConstructorParameters<typeof MaxforgeWebSocketBridge>[0]> {
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

export async function createMaxforgeMcpRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  getBrokerStatus?: () => BrokerStatus
): Promise<MaxforgeMcpRuntime> {
  const catalogOptions = catalogOptionsFromEnvironment(environment);
  let catalog = await loadObjectCatalog(catalogOptions);
  const version = await packageVersion();
  const bridgeOptions = {
    ...bridgeOptionsFromEnvironment(environment),
    expectedExternalVersion: version,
  };
  const editHistoryDirectory = editHistoryDirectoryFromEnvironment(
    environment,
    catalog.project
  );
  const editHistoryStore = editHistoryDirectory && catalog.project
    ? new JsonLinesEditHistoryStore({
      ...editHistoryOptionsFromEnvironment(
        environment,
        catalog.project,
        editHistoryDirectory
      ),
      recoverStaleWriterLease: true,
    })
    : undefined;
  const bridge = new MaxforgeWebSocketBridge(bridgeOptions, editHistoryStore);
  const status = await bridge.start();

  try {
    const stateFile = stateFileFromEnvironment(
      environment,
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
    return {
      bridge,
      service,
      version,
      stateStore,
      editHistoryStore,
      getCatalog: () => catalog,
      createServer: () => createMaxforgeMcpServer({
        service,
        transport: bridge,
        version,
        getCatalog: () => catalog,
        setCatalog: (replacement) => {
          catalog = replacement;
        },
        replaceObjectDatabase: (database) =>
          patchAdapter.replaceDatabase(database),
        reloadCatalog: () => loadObjectCatalog(catalogOptions),
        getBrokerStatus,
      }),
      close: () => bridge.close(),
    };
  } catch (error) {
    await bridge.close();
    throw error;
  }
}

export async function packageVersion(): Promise<string> {
  const packageUrl = new URL("../../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
    version?: unknown;
  };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

export function optionalEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function integerEnvironment(
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
