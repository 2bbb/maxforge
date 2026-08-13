import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryTransport,
  JSONRPCMessage,
  McpServer,
} from "@modelcontextprotocol/server";
import dbData from "../data/objects.json" with { type: "json" };
import { LoadedObjectCatalog } from "../src/core/catalog-config.js";
import { ObjectDatabase } from "../src/core/types.js";
import {
  CloseMaxPatchRequest,
  CreateMaxPatchRequest,
  MaxforgeAppliedEvent,
  MaxforgeBridgeStatus,
  MaxforgeEditObservationHistory,
  MaxforgePatchClosingEvent,
  MaxforgePatchInfo,
  MaxforgePatchSavedEvent,
  MaxforgeSnapshotEvent,
  OpenMaxPatchRequest,
  PatchPlanTransport,
  SaveMaxPatchRequest,
} from "../src/max/patch-protocol.js";
import { createMaxforgeMcpServer } from "../src/mcp/mcp-server.js";
import { MaxforgePatchService } from "../src/mcp/service.js";
import { DslPatchAdapter } from "../src/mcp/dsl-patch-adapter.js";
import { PatchPlan } from "../src/max/patch-graph.js";
import { JsonLinesEditHistoryStore } from "../src/mcp/edit-history-store.js";

const database = dbData as ObjectDatabase;
const configuredDatabase: ObjectDatabase = {
  ...database,
  "vendor.test~": {
    maxclass: "newobj",
    numinlets: 2,
    numoutlets: 1,
    outlettype: ["signal"],
    defaultSize: [100, 22],
    category: "external",
  },
};
const catalog: LoadedObjectCatalog = {
  database: configuredDatabase,
  project: { id: "studio_patchset", name: "Studio Patchset" },
  configPath: "/project/maxforge.config.json",
  sources: ["/project/maxforge.config.json"],
  digest: "c".repeat(64),
  customObjects: [{
    name: "vendor.test~",
    kind: "external",
    source: "/project/maxforge.config.json",
    paths: [],
    ports: "fixed",
    definition: configuredDatabase["vendor.test~"],
  }],
};

const reloadedDatabase: ObjectDatabase = {
  ...configuredDatabase,
  "vendor.reloaded": {
    maxclass: "newobj",
    numinlets: 1,
    numoutlets: 1,
    outlettype: ["int"],
    defaultSize: [100, 22],
    category: "external",
  },
};
const reloadedCatalog: LoadedObjectCatalog = {
  ...catalog,
  database: reloadedDatabase,
  digest: "d".repeat(64),
  customObjects: [
    ...catalog.customObjects,
    {
      name: "vendor.reloaded",
      kind: "external",
      source: "/project/maxforge.config.json",
      paths: [],
      ports: "fixed",
      definition: reloadedDatabase["vendor.reloaded"],
    },
  ],
};

describe("maxforge MCP protocol surface", () => {
  it("lists tools and compiles a plan over an MCP transport", async () => {
    const transport = new FakeTransport();
    const patchAdapter = new DslPatchAdapter(configuredDatabase);
    const service = new MaxforgePatchService(patchAdapter, transport);
    let reloadShouldFail = false;
    let reloadProjectId = "studio_patchset";
    const server = createMaxforgeMcpServer({
      service,
      transport,
      version: "test",
      catalog,
      replaceObjectDatabase: (database) =>
        patchAdapter.replaceDatabase(database),
      reloadCatalog: async () => {
        if (reloadShouldFail) throw new Error("invalid replacement catalog");
        return {
          ...reloadedCatalog,
          project: { id: reloadProjectId },
        };
      },
    });
    const client = new InMemoryMcpClient(server);

    try {
      await client.connect();
      const tools = await client.request(2, "tools/list", {});
      expect(toolNames(tools)).toEqual([
        "maxforge_help",
        "maxforge_status",
        "maxforge_catalog",
        "maxforge_reload_catalog",
        "maxforge_list_patches",
        "maxforge_create_patch",
        "maxforge_open_patch",
        "maxforge_save_patch",
        "maxforge_close_patch",
        "maxforge_inspect_patch",
        "maxforge_review_live_changes",
        "maxforge_get_live_edit_history",
        "maxforge_get_patch_history_identity",
        "maxforge_resolve_patch_history_identity",
        "maxforge_erase_project_history",
        "maxforge_adopt_live_changes",
        "maxforge_reconcile_patch",
        "maxforge_compile_plan",
        "maxforge_apply_dsl",
      ]);
      const definitions = toolDefinitions(tools);
      expect(definitions).toHaveLength(19);
      expect(definitions.every((tool) => tool.outputSchema?.type === "object"))
        .toBe(true);
      expect(
        definitions.find((tool) => tool.name === "maxforge_apply_dsl")
          ?.description
      ).toContain("Do not retry");
      expect(JSON.stringify(
        definitions.find((tool) => tool.name === "maxforge_inspect_patch")
          ?.outputSchema
      )).toContain("connection_changed");
      expect(
        definitions.find((tool) => tool.name === "maxforge_review_live_changes")
          ?.description
      ).toContain("correlated edit clusters");
      expect(
        definitions.find((tool) => tool.name === "maxforge_adopt_live_changes")
          ?.description
      ).toContain("structure token");

      const help = await client.request(3, "tools/call", {
        name: "maxforge_help",
        arguments: { topic: "recovery" },
      });
      expect(help).toMatchObject({
        result: {
          structuredContent: {
            topic: "recovery",
            steps: expect.arrayContaining([
              expect.stringContaining("currentDsl"),
              expect.stringContaining("maxforge_review_live_changes"),
              expect.stringContaining("maxforge_adopt_live_changes"),
            ]),
            rules: expect.arrayContaining([
              expect.stringContaining("never silently chooses"),
            ]),
          },
        },
      });

      const workflowHelp = await client.request(31, "tools/call", {
        name: "maxforge_help",
        arguments: { topic: "workflow" },
      });
      expect(workflowHelp).toMatchObject({
        result: {
          structuredContent: {
            topic: "workflow",
            steps: expect.arrayContaining([
              expect.stringContaining("evidence of what changed"),
              expect.stringContaining("review.editClusters"),
              expect.stringContaining("exact reviewed structure token"),
              expect.stringContaining("workingDslRequiredAsCurrent"),
            ]),
            rules: expect.arrayContaining([
              expect.stringContaining("diff proves human intent"),
              expect.stringContaining("not silently claimed"),
            ]),
            relatedTools: expect.arrayContaining([
              "maxforge_review_live_changes",
              "maxforge_adopt_live_changes",
            ]),
          },
        },
      });

      const setupHelp = await client.request(33, "tools/call", {
        name: "maxforge_help",
        arguments: { topic: "setup" },
      });
      expect(setupHelp).toMatchObject({
        result: {
          structuredContent: {
            topic: "setup",
            rules: expect.arrayContaining([
              expect.stringContaining("MAXFORGE_WS_TOKEN"),
            ]),
          },
        },
      });

      const initialStatus = await client.request(30, "tools/call", {
        name: "maxforge_status",
        arguments: {},
      });
      expect(initialStatus).toMatchObject({
        result: {
          structuredContent: {
            bridge: {
              host: "127.0.0.1",
              port: 8766,
              connectedClients: 0,
            },
            managedRevisions: {},
            inspectionBaselineScopes: [],
            catalog: {
              digest: "c".repeat(64),
              configPath: "/project/maxforge.config.json",
              customObjectCount: 1,
              abstractionCount: 0,
            },
          },
        },
      });

      const catalogResult = await client.request(34, "tools/call", {
        name: "maxforge_catalog",
        arguments: {},
      });
      expect(catalogResult).toMatchObject({
        result: {
          structuredContent: {
            totalMatches: 1,
            truncated: false,
            objects: [{
              name: "vendor.test~",
              kind: "external",
              numinlets: 2,
              numoutlets: 1,
              outlettype: ["signal"],
            }],
          },
        },
      });

      const customPlan = await client.request(35, "tools/call", {
        name: "maxforge_compile_plan",
        arguments: {
          patcherId: "patch_a",
          scope: "custom",
          desiredDsl: "filter = vendor.test~",
        },
      });
      expect(customPlan).toMatchObject({
        result: {
          structuredContent: {
            operationCount: 1,
            plan: {
              operations: [{
                op: "create",
                box: { text: "vendor.test~", numinlets: 2, numoutlets: 1 },
              }],
            },
          },
        },
      });

      const reload = await client.request(36, "tools/call", {
        name: "maxforge_reload_catalog",
        arguments: {},
      });
      expect(reload).toMatchObject({
        result: {
          structuredContent: {
            previous: { digest: "c".repeat(64), customObjectCount: 1 },
            catalog: { digest: "d".repeat(64), customObjectCount: 2 },
            changed: true,
          },
        },
      });

      const reloadedPlan = await client.request(37, "tools/call", {
        name: "maxforge_compile_plan",
        arguments: {
          patcherId: "patch_a",
          scope: "reloaded",
          desiredDsl: "item = vendor.reloaded",
        },
      });
      expect(reloadedPlan).toMatchObject({
        result: {
          structuredContent: {
            plan: {
              operations: [{
                op: "create",
                box: { text: "vendor.reloaded", numinlets: 1, numoutlets: 1 },
              }],
            },
          },
        },
      });

      reloadProjectId = "another_project";
      const rejectedProjectSwitch = await client.request(371, "tools/call", {
        name: "maxforge_reload_catalog",
        arguments: {},
      });
      expect(rejectedProjectSwitch).toMatchObject({
        result: {
          isError: true,
          content: [{
            type: "text",
            text: expect.stringContaining("project.id cannot change"),
          }],
        },
      });

      reloadProjectId = "studio_patchset";
      reloadShouldFail = true;
      const rejectedReload = await client.request(38, "tools/call", {
        name: "maxforge_reload_catalog",
        arguments: {},
      });
      expect(rejectedReload).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: "invalid replacement catalog" }],
        },
      });
      const statusAfterRejectedReload = await client.request(39, "tools/call", {
        name: "maxforge_status",
        arguments: {},
      });
      expect(statusAfterRejectedReload).toMatchObject({
        result: {
          structuredContent: {
            catalog: { digest: "d".repeat(64), customObjectCount: 2 },
          },
        },
      });

      const result = await client.request(4, "tools/call", {
        name: "maxforge_compile_plan",
        arguments: {
          patcherId: "patch_a",
          scope: "voices",
          desiredDsl: "osc = cycle~ 440",
        },
      });
      expect(result).toMatchObject({
        result: {
          structuredContent: {
            operationCount: 1,
            plan: {
              scope: "voices",
              operations: [{ op: "create" }],
            },
          },
        },
      });

      const inspection = await client.request(5, "tools/call", {
        name: "maxforge_inspect_patch",
        arguments: { patcherId: "patch_a", scope: "voices" },
      });
      expect(inspection).toMatchObject({
        result: {
          structuredContent: {
            comparisonAvailable: false,
            managedChangeCount: 0,
            snapshot: {
              type: "maxforge.snapshot",
              patcherId: "patch_a",
              scope: "voices",
            },
          },
        },
      });

      const liveChangeReview = await client.request(51, "tools/call", {
        name: "maxforge_review_live_changes",
        arguments: { patcherId: "patch_a", scope: "voices" },
      });
      expect(liveChangeReview).toMatchObject({
        result: {
          structuredContent: {
            patcherId: "patch_a",
            scope: "voices",
            comparisonAvailable: false,
            canAdopt: false,
            adoptionBlockedReason: expect.stringContaining(
              "No acknowledged managed graph"
            ),
            review: {
              affectedManagedIds: [],
              affectedUnmanagedRuntimeIds: [],
              signals: [],
              editClusters: [],
              interpretationGuidance: {
                mode: "evidence_only",
                clarificationRecommendedFor: [],
              },
            },
          },
        },
      });

      const liveEditHistory = await client.request(52, "tools/call", {
        name: "maxforge_get_live_edit_history",
        arguments: {
          patcherId: "patch_a",
          scope: "voices",
          afterSequence: 0,
        },
      });
      expect(liveEditHistory).toMatchObject({
        result: {
          structuredContent: {
            patcherId: "patch_a",
            scope: "voices",
            supported: true,
            droppedEvents: 0,
            latestSequence: null,
            observations: [],
            limitations: expect.arrayContaining([
              expect.stringContaining("not Max undo actions"),
            ]),
          },
        },
      });

      const reconciliation = await client.request(32, "tools/call", {
        name: "maxforge_reconcile_patch",
        arguments: {
          patcherId: "patch_a",
          scope: "voices",
          desiredDsl: "osc = cycle~ 440",
        },
      });
      expect(reconciliation).toMatchObject({
        result: {
          structuredContent: {
            patcherId: "patch_a",
            scope: "voices",
            canApply: true,
            conflicts: [],
            operationCount: 1,
            plan: { operations: [{ op: "create" }] },
          },
        },
      });

      const applied = await client.request(31, "tools/call", {
        name: "maxforge_apply_dsl",
        arguments: {
          patcherId: "patch_a",
          scope: "voices",
          desiredDsl: "osc = cycle~ 440",
        },
      });
      expect(applied).toMatchObject({
        result: {
          structuredContent: {
            patcherId: "patch_a",
            scope: "voices",
            operationCount: 1,
            acknowledgement: {
              type: "maxforge.applied",
              patcherId: "patch_a",
              scope: "voices",
              operations: 1,
            },
            baselineCaptured: false,
            baselineWarning: expect.stringContaining("Max applied the patch"),
            manualChangesMerged: 0,
            workingDsl: expect.stringContaining("osc = cycle~ 440"),
            workingDslRequiredAsCurrent: false,
            warnings: [],
          },
        },
      });

      const created = await client.request(6, "tools/call", {
        name: "maxforge_create_patch",
        arguments: {
          patcherId: "generated_patch",
          scope: "generated",
          title: "Generated patch",
        },
      });
      expect(created).toMatchObject({
        result: {
          structuredContent: {
            patch: {
              patcherId: "generated_patch",
              scope: "generated",
              title: "Generated patch",
              controller: false,
            },
          },
        },
      });

      const opened = await client.request(61, "tools/call", {
        name: "maxforge_open_patch",
        arguments: {
          patcherId: "opened_patch",
          scope: "opened",
          title: "Opened patch",
          path: "/tmp/opened.maxpat",
        },
      });
      expect(opened).toMatchObject({
        result: {
          structuredContent: {
            patch: {
              patcherId: "opened_patch",
              filepath: "/tmp/opened.maxpat",
            },
          },
        },
      });

      const saved = await client.request(62, "tools/call", {
        name: "maxforge_save_patch",
        arguments: {
          patcherId: "opened_patch",
          scope: "opened",
          path: "/tmp/saved.maxpat",
        },
      });
      expect(saved).toMatchObject({
        result: {
          structuredContent: {
            saved: {
              type: "maxforge.patch.saved",
              filepath: "/tmp/saved.maxpat",
              dirty: false,
            },
          },
        },
      });

      const closed = await client.request(63, "tools/call", {
        name: "maxforge_close_patch",
        arguments: {
          patcherId: "opened_patch",
          scope: "opened",
          discard: true,
        },
      });
      expect(closed).toMatchObject({
        result: {
          structuredContent: {
            closing: {
              type: "maxforge.patch.closing",
              discarded: true,
            },
          },
        },
      });

      const patches = await client.request(7, "tools/call", {
        name: "maxforge_list_patches",
        arguments: {},
      });
      expect(patches).toMatchObject({
        result: {
          structuredContent: {
            patches: [],
          },
        },
      });
    } finally {
      await client.close();
    }
  });

  it("inspects and explicitly rekeys disconnected persistent history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-mcp-identity-"));
    const transport = new FakeTransport();
    const store = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    store.load();
    const snapshot = await transport.inspect("patch_a", "voices");
    store.startSession({
      patcherId: "patch_a",
      scope: "voices",
      instanceId: "instance_a",
      sessionId: "session_a",
      revision: null,
      controller: false,
      title: "Patch A",
      filename: "patch-a.maxpat",
      filepath: "/project/patch-a.maxpat",
      capabilities: ["edit_observation_v1", "session_baseline_v1"],
    }, {
      structureToken: snapshot.structureToken,
      patcher: snapshot.patcher,
    }, "2026-08-13T00:00:00.000Z");
    const patchAdapter = new DslPatchAdapter(configuredDatabase);
    const service = new MaxforgePatchService(
      patchAdapter,
      transport,
      undefined,
      store
    );
    const server = createMaxforgeMcpServer({
      service,
      transport,
      version: "test",
      catalog,
      replaceObjectDatabase: (database) =>
        patchAdapter.replaceDatabase(database),
      reloadCatalog: async () => catalog,
    });
    const client = new InMemoryMcpClient(server);

    try {
      await client.connect();
      const before = await client.request(101, "tools/call", {
        name: "maxforge_get_patch_history_identity",
        arguments: { patcherId: "patch_a", scope: "voices" },
      });
      expect(before).toMatchObject({
        result: { structuredContent: {
          projectId: "studio_patchset",
          known: true,
          canonical: { patcherId: "patch_a", scope: "voices" },
        } },
      });

      const rekeyed = await client.request(102, "tools/call", {
        name: "maxforge_resolve_patch_history_identity",
        arguments: {
          action: "rekey",
          expectedProjectId: "studio_patchset",
          sourcePatcherId: "patch_a",
          scope: "voices",
          targetPatcherId: "patch_renamed",
          reason: "Human confirmed a deliberate patcherId rename",
        },
      });
      expect(rekeyed).toMatchObject({
        result: { structuredContent: {
          action: "rekey",
          physicalDataErased: false,
          canonical: { patcherId: "patch_renamed", scope: "voices" },
          aliases: [{ patcherId: "patch_a", scope: "voices" }],
        } },
      });

      const erased = await client.request(103, "tools/call", {
        name: "maxforge_erase_project_history",
        arguments: {
          expectedProjectId: "studio_patchset",
          confirmation: "ERASE PROJECT HISTORY studio_patchset",
        },
      });
      expect(erased).toMatchObject({
        result: { structuredContent: {
          projectId: "studio_patchset",
          filesDeleted: 2,
          retainedObservationsCleared: 0,
          physicalDataDeleted: true,
          secureOverwriteGuaranteed: false,
        } },
      });
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

class InMemoryMcpClient {
  private readonly clientTransport: InMemoryTransport;
  private readonly serverTransport: InMemoryTransport;
  private readonly responses = new Map<number, (message: JSONRPCMessage) => void>();

  constructor(private readonly server: McpServer) {
    [this.clientTransport, this.serverTransport] =
      InMemoryTransport.createLinkedPair();
    this.clientTransport.onmessage = (message) => {
      if (!("id" in message) || typeof message.id !== "number") return;
      this.responses.get(message.id)?.(message);
      this.responses.delete(message.id);
    };
  }

  async connect(): Promise<void> {
    await this.clientTransport.start();
    await this.server.connect(this.serverTransport);
    await this.request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "maxforge-test", version: "1" },
    });
    await this.clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  }

  request(
    id: number,
    method: string,
    params: Record<string, unknown>
  ): Promise<JSONRPCMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 1000);
      this.responses.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      void this.clientTransport.send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}

function toolNames(message: JSONRPCMessage): string[] {
  return toolDefinitions(message).map((tool) => tool.name);
}

function toolDefinitions(message: JSONRPCMessage): Array<{
  name: string;
  description?: string;
  outputSchema?: { type?: unknown };
}> {
  if (!("result" in message)) return [];
  const result = message.result as {
    tools?: Array<{
      name?: unknown;
      description?: unknown;
      outputSchema?: { type?: unknown };
    }>;
  };
  return result.tools
    ?.filter((tool): tool is {
      name: string;
      description?: string;
      outputSchema?: { type?: unknown };
    } => typeof tool.name === "string") ?? [];
}

class FakeTransport implements PatchPlanTransport {
  async apply(
    patcherId: string,
    plan: PatchPlan
  ): Promise<MaxforgeAppliedEvent> {
    return {
      type: "maxforge.applied",
      requestId: "mcp-apply",
      patcherId,
      scope: plan.scope,
      revision: plan.targetRevision,
      operations: plan.operations.length,
    };
  }

  async inspect(
    patcherId: string,
    scope: string
  ): Promise<MaxforgeSnapshotEvent> {
    return {
      type: "maxforge.snapshot",
      requestId: "mcp-test",
      patcherId,
      scope,
      revision: null,
      structureToken: "0".repeat(16),
      patcher: {
        title: "MCP test",
        filename: "test.maxpat",
        filepath: "/tmp/test.maxpat",
        dirty: false,
        locked: false,
        presentation: false,
        boxes: [],
        connections: [],
      },
    };
  }

  getEditObservationHistory(): MaxforgeEditObservationHistory {
    return {
      supported: true,
      droppedEvents: 0,
      persistence: {
        enabled: false,
        projectId: null,
        location: null,
        warnings: [],
      },
      identity: null,
      patchMetadata: [],
      observations: [],
    };
  }

  clearEditObservationHistory(): number {
    return 0;
  }

  async createPatch(
    request: CreateMaxPatchRequest
  ): Promise<MaxforgePatchInfo> {
    return {
      ...request,
      instanceId: "mcp-test-instance",
      sessionId: "mcp-test-session",
      revision: null,
      controller: false,
      filename: "",
      filepath: "",
      capabilities: ["edit_observation_v1"],
    };
  }

  async openPatch(request: OpenMaxPatchRequest): Promise<MaxforgePatchInfo> {
    return {
      ...request,
      instanceId: "mcp-test-instance",
      sessionId: "mcp-test-session",
      revision: null,
      controller: false,
      filename: request.path.split(/[\\/]/).at(-1) ?? "",
      filepath: request.path,
      capabilities: ["edit_observation_v1"],
    };
  }

  async savePatch(
    request: SaveMaxPatchRequest
  ): Promise<MaxforgePatchSavedEvent> {
    const filepath = request.path ?? "/tmp/test.maxpat";
    return {
      type: "maxforge.patch.saved",
      requestId: "mcp-save",
      patcherId: request.patcherId,
      scope: request.scope,
      filename: filepath.split(/[\\/]/).at(-1) ?? "",
      filepath,
      dirty: false,
    };
  }

  async closePatch(
    request: CloseMaxPatchRequest
  ): Promise<MaxforgePatchClosingEvent> {
    return {
      type: "maxforge.patch.closing",
      requestId: "mcp-close",
      patcherId: request.patcherId,
      scope: request.scope,
      discarded: request.discard ?? false,
    };
  }

  listPatches(): readonly MaxforgePatchInfo[] {
    return [];
  }

  getLiveRevision(): string | null | undefined {
    return undefined;
  }

  getStatus(): MaxforgeBridgeStatus {
    return {
      host: "127.0.0.1",
      port: 8766,
      connectedClients: 0,
      registeredPatches: [],
      liveRevisions: {},
      editHistoryPersistence: {
        enabled: false,
        projectId: null,
        location: null,
        warnings: [],
      },
    };
  }
}
