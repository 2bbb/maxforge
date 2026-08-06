import { describe, expect, it } from "vitest";
import {
  InMemoryTransport,
  JSONRPCMessage,
  McpServer,
} from "@modelcontextprotocol/server";
import dbData from "../data/objects.json" with { type: "json" };
import { ObjectDatabase } from "../src/core/types.js";
import {
  CreateMaxPatchRequest,
  MaxforgeAppliedEvent,
  MaxforgeBridgeStatus,
  MaxforgePatchInfo,
  MaxforgeSnapshotEvent,
  PatchPlanTransport,
} from "../src/mcp/bridge.js";
import { createMaxforgeMcpServer } from "../src/mcp/mcp-server.js";
import { MaxforgePatchService } from "../src/mcp/service.js";
import { PatchPlan } from "../src/max/patch-graph.js";

const database = dbData as ObjectDatabase;

describe("maxforge MCP protocol surface", () => {
  it("lists tools and compiles a plan over an MCP transport", async () => {
    const transport = new FakeTransport();
    const service = new MaxforgePatchService(database, transport);
    const server = createMaxforgeMcpServer({
      service,
      transport,
      version: "test",
    });
    const client = new InMemoryMcpClient(server);

    try {
      await client.connect();
      const tools = await client.request(2, "tools/list", {});
      expect(toolNames(tools)).toEqual([
        "maxforge_help",
        "maxforge_status",
        "maxforge_list_patches",
        "maxforge_create_patch",
        "maxforge_inspect_patch",
        "maxforge_reconcile_patch",
        "maxforge_compile_plan",
        "maxforge_apply_dsl",
      ]);
      const definitions = toolDefinitions(tools);
      expect(definitions).toHaveLength(8);
      expect(definitions.every((tool) => tool.outputSchema?.type === "object"))
        .toBe(true);
      expect(
        definitions.find((tool) => tool.name === "maxforge_apply_dsl")
          ?.description
      ).toContain("Do not retry");

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
            ]),
            rules: expect.arrayContaining([
              expect.stringContaining("never silently chooses"),
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

  async createPatch(
    request: CreateMaxPatchRequest
  ): Promise<MaxforgePatchInfo> {
    return {
      ...request,
      revision: null,
      controller: false,
      filename: "",
      filepath: "",
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
    };
  }
}
