import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { MaxforgePatchService } from "./service.js";
import { PatchPlanTransport } from "./bridge.js";

const scopeSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "scope must start with a letter or underscore and contain only word characters"
  );

const dslRequestSchema = z.object({
  desiredDsl: z.string().min(1).describe("Complete desired maxforge DSL source"),
  scope: scopeSchema.describe("Managed patch scope"),
  currentDsl: z
    .string()
    .optional()
    .describe(
      "Current DSL state. Required once after MCP restart if Max is already initialized."
    ),
});

export interface CreateMcpServerOptions {
  readonly service: MaxforgePatchService;
  readonly transport: PatchPlanTransport;
  readonly version: string;
}

export function createMaxforgeMcpServer(
  options: CreateMcpServerOptions
): McpServer {
  const server = new McpServer(
    {
      name: "maxforge",
      version: options.version,
    },
    {
      instructions:
        "Use maxforge_status and maxforge_inspect_patch before mutation. Use " +
        "maxforge_compile_plan to inspect a DSL diff and maxforge_apply_dsl " +
        "to apply complete desired DSL. Only maxforge-managed objects in the " +
        "selected scope may be changed.",
    }
  );

  server.registerTool(
    "maxforge_status",
    {
      title: "Maxforge status",
      description:
        "Report localhost transport connections, live Max revisions, and MCP graph state.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const result = {
        bridge: options.transport.getStatus(),
        managedRevisions: options.service.getManagedRevisions(),
        inspectionBaselineScopes: options.service.getBaselineScopes(),
      };
      return toolResult(result);
    }
  );

  server.registerTool(
    "maxforge_inspect_patch",
    {
      title: "Inspect live Max patch",
      description:
        "Read the live patcher graph without using the screen and report structural changes since the last acknowledged maxforge apply.",
      inputSchema: z.object({
        scope: scopeSchema.describe("Managed patch scope to inspect"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ scope }) => {
      try {
        const result = await options.service.inspectPatch(scope);
        return toolResult({
          scope,
          comparisonAvailable: result.comparisonAvailable,
          managedChangeCount: result.managedChangeCount,
          unmanagedChangeCount: result.unmanagedChangeCount,
          changes: result.changes,
          snapshot: result.snapshot,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_compile_plan",
    {
      title: "Compile maxforge patch plan",
      description:
        "Compile desired DSL into a PatchPlan without connecting to or mutating Max.",
      inputSchema: dslRequestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (request) => {
      try {
        const result = options.service.compilePlan(request);
        return toolResult({
          plan: result.plan,
          operationCount: result.plan.operations.length,
          warnings: result.warnings,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_apply_dsl",
    {
      title: "Apply desired maxforge DSL",
      description:
        "Compile complete desired DSL, send its managed diff to one connected Max client, and wait for maxforge.sync acknowledgement.",
      inputSchema: dslRequestSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (request) => {
      try {
        const result = await options.service.applyDsl(request);
        return toolResult({
          scope: result.plan.scope,
          baseRevision: result.plan.baseRevision,
          targetRevision: result.plan.targetRevision,
          operationCount: result.plan.operations.length,
          acknowledgement: result.acknowledgement,
          baselineCaptured: result.baselineCaptured,
          ...(result.baselineWarning
            ? { baselineWarning: result.baselineWarning }
            : {}),
          warnings: result.warnings,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
