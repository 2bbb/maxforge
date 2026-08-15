import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadObjectCatalog } from "../core/catalog-config.js";
import {
  editHistoryDirectoryFromEnvironment,
  editHistoryOptionsFromEnvironment,
} from "./edit-history-store.js";
import { stateFileFromEnvironment } from "./state-store.js";
import type { ProcessLeaseStatus } from "./process-lease.js";
import {
  bridgeOptionsFromEnvironment,
  catalogOptionsFromEnvironment,
  integerEnvironment,
  packageVersion,
} from "./runtime.js";

export const BROKER_PROTOCOL = "maxforge-broker-v1";
export const BROKER_HOST = "127.0.0.1";
const BROKER_PORT_BASE = 39000;
const BROKER_PORT_RANGE = 20000;
const BROKER_OWNER_PORT_BASE = 10000;
const BROKER_OWNER_PORT_RANGE = 20000;

export type BrokerAction = "mcp" | "probe" | "status" | "stop";

export interface BrokerDescriptor {
  readonly protocol: typeof BROKER_PROTOCOL;
  readonly key: string;
  readonly host: typeof BROKER_HOST;
  readonly port: number;
  readonly ownerPort: number;
  readonly clientVersion: string;
  readonly configurationFingerprint: string;
  readonly ownerLeasePath: string;
}

export interface BrokerRequest extends BrokerDescriptor {
  readonly action: BrokerAction;
  readonly force?: boolean;
}

export interface BrokerStatus {
  readonly state: "starting" | "ready" | "failed" | "draining";
  readonly brokerVersion: string;
  readonly pid: number;
  readonly mcpClients: number;
  readonly maxClients: number;
  readonly pendingOperations: number;
  readonly idleTimeoutMs: number;
  readonly ownerPort: number;
  readonly error?: string;
  readonly ownership: ProcessLeaseStatus;
}

export type BrokerResponse = {
  readonly protocol: typeof BROKER_PROTOCOL;
  readonly ok: true;
  readonly key: string;
  readonly status: BrokerStatus;
} | {
  readonly protocol: typeof BROKER_PROTOCOL;
  readonly ok: false;
  readonly key?: string;
  readonly code:
    | "INVALID_REQUEST"
    | "WRONG_BROKER"
    | "CONFIGURATION_MISMATCH"
    | "VERSION_MISMATCH"
    | "STARTING"
    | "UNAVAILABLE"
    | "BUSY";
  readonly error: string;
  readonly status?: BrokerStatus;
};

export async function brokerDescriptorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Promise<BrokerDescriptor> {
  const catalog = await loadObjectCatalog(catalogOptionsFromEnvironment(environment));
  const bridge = bridgeOptionsFromEnvironment(environment);
  const key = catalog.project?.id
    ? `project:${catalog.project.id}`
    : `bridge:${bridge.host ?? "127.0.0.1"}:${bridge.port ?? 8766}`;
  const explicitPort = environment.MAXFORGE_BROKER_PORT === undefined
    ? undefined
    : integerEnvironment(environment, "MAXFORGE_BROKER_PORT", 0);
  const port = explicitPort ?? brokerPortForKey(key);
  if (port < 1024 || 65535 < port) {
    throw new Error(`MAXFORGE_BROKER_PORT must be between 1024 and 65535`);
  }

  const ownerLeasePath = join(
    resolve(environment.MAXFORGE_BROKER_DIR ?? join(homedir(), ".maxforge", "brokers")),
    `${createHash("sha256").update(key).digest("hex")}-v1.lock`
  );
  const ownerPort = brokerOwnerPortForKey(key);
  const editHistoryDirectory = editHistoryDirectoryFromEnvironment(
    environment,
    catalog.project
  );
  const editHistory = editHistoryDirectory && catalog.project
    ? editHistoryOptionsFromEnvironment(
      environment,
      catalog.project,
      editHistoryDirectory
    )
    : null;
  const stateFile = stateFileFromEnvironment(
    environment,
    bridge.port ?? 8766,
    catalog.project?.id
  );
  return {
    protocol: BROKER_PROTOCOL,
    key,
    host: BROKER_HOST,
    port,
    ownerPort,
    clientVersion: await packageVersion(),
    ownerLeasePath,
    // The catalog digest is deliberately excluded: a running broker can reload
    // catalog contents in place. This fingerprint covers startup-owned
    // resources and policies that cannot be changed safely by a new frontend.
    configurationFingerprint: configurationFingerprint(environment, {
      projectId: catalog.project?.id ?? null,
      configPath: catalog.configPath ? resolve(catalog.configPath) : null,
      bridge: {
        host: bridge.host,
        port: bridge.port,
        applyTimeoutMs: bridge.applyTimeoutMs,
        tokenConfigured: bridge.token !== undefined,
      },
      ownerLeasePath,
      ownerPort,
      stateFile: stateFile ?? null,
      editHistory,
      idleTimeoutMs: integerEnvironment(
        environment,
        "MAXFORGE_BROKER_IDLE_MS",
        300000
      ),
    }),
  };
}

export function brokerPortForKey(key: string): number {
  const digest = createHash("sha256").update(key).digest();
  return BROKER_PORT_BASE + digest.readUInt32BE(0) % BROKER_PORT_RANGE;
}

export function brokerOwnerPortForKey(key: string): number {
  const digest = createHash("sha256").update(`owner:${key}`).digest();
  return BROKER_OWNER_PORT_BASE +
    digest.readUInt32BE(0) % BROKER_OWNER_PORT_RANGE;
}

function configurationFingerprint(
  environment: NodeJS.ProcessEnv,
  runtime: Record<string, unknown>
): string {
  const token = environment.MAXFORGE_WS_TOKEN;
  const source = JSON.stringify({
    ...runtime,
    tokenHash: token
      ? createHash("sha256").update(token).digest("hex")
      : null,
  });
  return createHash("sha256").update(source).digest("hex");
}

export function parseBrokerRequest(source: string): BrokerRequest | undefined {
  try {
    const value = JSON.parse(source) as Partial<BrokerRequest>;
    if (
      value.protocol !== BROKER_PROTOCOL ||
      (
        value.action !== "mcp" &&
        value.action !== "probe" &&
        value.action !== "status" &&
        value.action !== "stop"
      ) ||
      typeof value.key !== "string" ||
      value.host !== BROKER_HOST ||
      !Number.isInteger(value.port) ||
      !Number.isInteger(value.ownerPort) ||
      typeof value.clientVersion !== "string" ||
      typeof value.configurationFingerprint !== "string" ||
      typeof value.ownerLeasePath !== "string" ||
      (value.force !== undefined && typeof value.force !== "boolean")
    ) {
      return undefined;
    }
    return value as BrokerRequest;
  } catch {
    return undefined;
  }
}
