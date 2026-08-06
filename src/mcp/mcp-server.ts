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

const patcherIdSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*$/,
    "patcherId must start with a letter or underscore and contain only letters, digits, underscores, and hyphens"
  );

const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "revision must be a 64-character lowercase SHA-256 hash");

const patchInfoSchema = z.object({
  patcherId: patcherIdSchema.describe("Stable transport ID; use this instead of a window title"),
  scope: scopeSchema.describe("Managed namespace advertised by this patch"),
  revision: revisionSchema.nullable().describe("Live managed revision, or null before the first apply"),
  controller: z.boolean().describe("Whether this patch may create new top-level patches"),
  title: z.string().describe("Display-only Max window title"),
  filename: z.string().describe("Display-only Max document filename"),
  filepath: z.string().describe("Saved document path, or an empty string for an unsaved patch"),
});

const warningSchema = z.object({
  code: z.string().describe("Stable maxforge warning code"),
  message: z.string(),
  line: z.number().int().positive().optional(),
});

const patchPlanSchema = z.object({
  protocolVersion: z.literal(1),
  scope: scopeSchema,
  baseRevision: revisionSchema,
  targetRevision: revisionSchema,
  operations: z.array(
    z.object({
      op: z.enum(["disconnect", "delete", "create", "set", "connect"]),
      targetPath: z.array(z.string()),
    }).passthrough()
  ).describe("Ordered native Max mutations; review these before apply"),
});

const snapshotEndpointSchema = z.object({
  runtimeId: z.string(),
  varName: z.string(),
  port: z.number().int().nonnegative(),
});

const snapshotBoxSchema = z.object({
  targetPath: z.array(z.string()),
  runtimeId: z.string(),
  varName: z.string(),
  maxclass: z.string(),
  patchingRect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  managed: z.boolean(),
  text: z.string().optional(),
});

const snapshotConnectionSchema = z.object({
  targetPath: z.array(z.string()),
  source: snapshotEndpointSchema,
  destination: snapshotEndpointSchema,
});

const snapshotEventSchema = z.object({
  type: z.literal("maxforge.snapshot"),
  requestId: z.string(),
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  revision: revisionSchema.nullable(),
  patcher: z.object({
    title: z.string(),
    filename: z.string(),
    filepath: z.string(),
    dirty: z.boolean(),
    locked: z.boolean(),
    presentation: z.boolean(),
    boxes: z.array(snapshotBoxSchema),
    connections: z.array(snapshotConnectionSchema),
  }),
});

const acknowledgementSchema = z.object({
  type: z.literal("maxforge.applied"),
  requestId: z.string(),
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  revision: revisionSchema,
  operations: z.number().int().nonnegative(),
});

const helpTopicSchema = z.enum(["workflow", "setup", "recovery", "safety"]);

const helpResultSchema = z.object({
  topic: helpTopicSchema,
  summary: z.string(),
  steps: z.array(z.string()),
  rules: z.array(z.string()),
  relatedTools: z.array(z.string()),
});

const dslRequestSchema = z.object({
  patcherId: patcherIdSchema.describe(
    "Registered target Max patch ID copied from maxforge_list_patches; never infer it from a title"
  ),
  desiredDsl: z.string().min(1).describe(
    "Complete desired maxforge DSL state. Managed objects omitted from this source are deleted."
  ),
  scope: scopeSchema.describe(
    "Exact managed scope advertised by the selected patch"
  ),
  currentDsl: z
    .string()
    .optional()
    .describe(
      "Exact previous complete DSL. Required once after MCP restart when Max already has a revision; never guess or substitute empty state."
    ),
});

const applyDslRequestSchema = dslRequestSchema.extend({
  manualChanges: z
    .enum(["reject", "merge"])
    .optional()
    .describe(
      "How to handle managed live edits. Defaults to reject. Use merge only after maxforge_reconcile_patch reports canApply=true for the same desired DSL."
    ),
});

const reconciliationConflictSchema = z.object({
  kind: z.string(),
  targetPath: z.array(z.string()),
  id: z.string().optional(),
  field: z.string().optional(),
  message: z.string(),
}).passthrough();

const HELP_CONTENT = {
  workflow: {
    summary: "Safe desired-state workflow for inspecting and changing one live Max patch.",
    steps: [
      "Call maxforge_list_patches and copy the target patcherId and scope exactly.",
      "Call maxforge_inspect_patch before mutation; do not infer patch state from the screen or title.",
      "If managed edits exist, call maxforge_reconcile_patch and require canApply=true before preserving them.",
      "Send the complete desired DSL to maxforge_compile_plan and review every operation and warning.",
      "Send the same target and complete desired DSL to maxforge_apply_dsl. Set manualChanges to merge only after reconciliation succeeds.",
      "Treat the apply as successful only when acknowledgement.revision equals targetRevision, then inspect again.",
      "After a merged apply, update the working complete DSL to include preserved human edits or keep using reconciliation for later changes.",
    ],
    rules: [
      "DSL is complete desired state, not an imperative edit; omitted managed objects are removed.",
      "Ordinary compile/apply is rejected while the acknowledged graph still differs from the agent's last desired DSL due to preserved human edits.",
      "Never mutate an unlisted patcherId or a scope different from the registration.",
      "Never retry a timeout or baseline warning blindly; inspect live state first.",
    ],
    relatedTools: [
      "maxforge_list_patches",
      "maxforge_inspect_patch",
      "maxforge_reconcile_patch",
      "maxforge_compile_plan",
      "maxforge_apply_dsl",
    ],
  },
  setup: {
    summary: "Runtime prerequisites for MCP-to-Max control.",
    steps: [
      "Run maxforge-mcp as an MCP stdio server with Node.js 20 or newer.",
      "Install the native maxforge.sync external separately; the npm package does not install the Max external.",
      "Open one controller patch containing maxforge.sync with controller enabled.",
      "Call maxforge_status, then maxforge_list_patches to verify registration before creating or changing patches.",
    ],
    rules: [
      "The WebSocket bridge is loopback-only and defaults to 127.0.0.1:8766.",
      "Do not write arbitrary output to MCP stdout; it is the protocol channel.",
      "New patch creation requires exactly one registered controller.",
    ],
    relatedTools: ["maxforge_status", "maxforge_list_patches", "maxforge_create_patch"],
  },
  recovery: {
    summary: "Recovery rules for stale process state, manual edits, timeouts, and partial failures.",
    steps: [
      "After an MCP process restart, call maxforge_list_patches and inspect the target.",
      "If Max reports an initialized revision but MCP has no graph, provide the exact previous complete DSL as currentDsl once.",
      "If inspect reports managed manual changes, call maxforge_reconcile_patch with the next complete desired DSL.",
      "If reconciliation reports canApply=true, apply the same DSL with manualChanges set to merge. Resolve reported conflicts explicitly instead of forcing a winner.",
      "After a timeout or transport error, call maxforge_status and maxforge_inspect_patch before deciding whether another apply is safe.",
      "If baselineCaptured is false, the apply still succeeded; do not repeat it solely to obtain a baseline.",
    ],
    rules: [
      "A revision hash proves identity but cannot reconstruct DSL or graph state.",
      "Reconciliation preserves non-conflicting managed edits but never silently chooses between conflicting changes.",
      "Protocol v1 is not transactional; a runtime mutation failure can leave a partial patch while the revision remains unchanged.",
    ],
    relatedTools: [
      "maxforge_status",
      "maxforge_inspect_patch",
      "maxforge_reconcile_patch",
      "maxforge_apply_dsl",
    ],
  },
  safety: {
    summary: "Ownership, identity, and mutation boundaries enforced by maxforge.",
    steps: [
      "Select targets only from maxforge_list_patches.",
      "Preview every nontrivial change with maxforge_compile_plan.",
      "Inspect after apply and separate managed from unmanaged changes.",
    ],
    rules: [
      "Only exact maxforge_<scope>_obj_... scripting names belong to the managed scope.",
      "Titles and filenames are display metadata and are not stable identities.",
      "Unmanaged standalone edits do not block apply, but cords touching managed boxes do.",
      "The loopback WebSocket transport is unauthenticated; do not expose it on a public interface.",
    ],
    relatedTools: ["maxforge_list_patches", "maxforge_compile_plan", "maxforge_inspect_patch"],
  },
} as const;

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
        "Call maxforge_help with topic 'workflow' before the first live mutation. " +
        "Always select patcherId and scope from maxforge_list_patches, inspect the " +
        "live patch, preview the complete desired DSL with maxforge_compile_plan, " +
        "then pass the same complete DSL to maxforge_apply_dsl. Omitted managed " +
        "objects are deleted. Success requires acknowledgement.revision to equal " +
        "targetRevision. Never retry a timeout or baseline warning blindly. After " +
        "an MCP restart, an initialized patch requires its exact previous complete " +
        "DSL as currentDsl once. Call maxforge_help with topic 'recovery' on errors " +
        "or managed manual drift. Preserve managed manual edits only after " +
        "maxforge_reconcile_patch returns canApply=true, then apply with " +
        "manualChanges set to merge.",
    }
  );

  server.registerTool(
    "maxforge_help",
    {
      title: "Maxforge MCP workflow help",
      description:
        "Return agent-oriented instructions for safe live patch workflow, setup, recovery, or safety. Call this before the first mutation and whenever an apply is rejected or ambiguous.",
      inputSchema: z.object({
        topic: helpTopicSchema.optional().describe(
          "Help topic; defaults to workflow"
        ),
      }),
      outputSchema: helpResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ topic }) => {
      const selectedTopic = topic ?? "workflow";
      return toolResult({ topic: selectedTopic, ...HELP_CONTENT[selectedTopic] });
    }
  );

  server.registerTool(
    "maxforge_status",
    {
      title: "Maxforge status",
      description:
        "Diagnose localhost transport and process-local state. Use when no patch is listed, after restart, or after a timeout; connected clients are not usable targets until registered.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        bridge: z.object({
          host: z.string(),
          port: z.number().int().nonnegative(),
          connectedClients: z.number().int().nonnegative(),
          registeredPatches: z.array(patchInfoSchema),
          liveRevisions: z.record(z.string(), revisionSchema.nullable()),
        }),
        managedRevisions: z.record(z.string(), revisionSchema),
        inspectionBaselineScopes: z.array(z.string()),
      }),
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
    "maxforge_list_patches",
    {
      title: "List live Max patches",
      description:
        "List registered Max patches. Always copy patcherId and scope from this result before inspect, compile, or apply; never target a patch by title or filename.",
      inputSchema: z.object({}),
      outputSchema: z.object({ patches: z.array(patchInfoSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => toolResult({ patches: options.transport.listPatches() })
  );

  server.registerTool(
    "maxforge_create_patch",
    {
      title: "Create Max patch",
      description:
        "Create an unsaved top-level Max patch containing its own maxforge.sync and wait for registration. Requires exactly one live controller and a globally unique patcherId.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe(
          "Unique stable ID for the new patch"
        ),
        scope: scopeSchema.describe("Managed scope in the new patch"),
        title: z.string().min(1).max(256).describe("Visible patch window title"),
      }),
      outputSchema: z.object({ patch: patchInfoSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (request) => {
      try {
        const patch = await options.transport.createPatch(request);
        return toolResult({ patch });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_inspect_patch",
    {
      title: "Inspect live Max patch",
      description:
        "Read the complete live patch graph without using the screen. Reports managed and unmanaged structural drift from the last acknowledged apply; inspection does not accept or reset that baseline.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Managed patch scope to inspect"),
      }),
      outputSchema: z.object({
        patcherId: patcherIdSchema,
        scope: scopeSchema,
        comparisonAvailable: z.boolean(),
        managedChangeCount: z.number().int().nonnegative(),
        unmanagedChangeCount: z.number().int().nonnegative(),
        changes: z.array(
          z.object({
            kind: z.enum([
              "box_added",
              "box_removed",
              "box_changed",
              "connection_added",
              "connection_removed",
            ]),
            managed: z.boolean(),
          }).passthrough()
        ),
        snapshot: snapshotEventSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope }) => {
      try {
        const result = await options.service.inspectPatch(patcherId, scope);
        return toolResult({
          patcherId,
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
    "maxforge_reconcile_patch",
    {
      title: "Reconcile live Max edits with desired DSL",
      description:
        "Preview a three-way merge of the last acknowledged graph, the current live patch, and complete desired DSL. Returns structured conflicts and never mutates Max.",
      inputSchema: dslRequestSchema,
      outputSchema: z.object({
        patcherId: patcherIdSchema,
        scope: scopeSchema,
        canApply: z.boolean(),
        comparisonAvailable: z.boolean(),
        managedChangeCount: z.number().int().nonnegative(),
        unmanagedChangeCount: z.number().int().nonnegative(),
        conflicts: z.array(reconciliationConflictSchema),
        plan: patchPlanSchema.optional(),
        operationCount: z.number().int().nonnegative(),
        warnings: z.array(warningSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (request) => {
      try {
        const result = await options.service.reconcilePlan(request);
        return toolResult({
          patcherId: request.patcherId,
          scope: request.scope,
          canApply: result.canApply,
          comparisonAvailable: result.comparisonAvailable,
          managedChangeCount: result.managedChangeCount,
          unmanagedChangeCount: result.unmanagedChangeCount,
          conflicts: result.conflicts,
          ...(result.plan ? { plan: result.plan } : {}),
          operationCount: result.plan?.operations.length ?? 0,
          warnings: result.warnings,
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
        "Preview the ordered diff from current managed state to complete desired DSL without mutating Max. Review destructive operations and warnings before apply.",
      inputSchema: dslRequestSchema,
      outputSchema: z.object({
        plan: patchPlanSchema,
        operationCount: z.number().int().nonnegative(),
        warnings: z.array(warningSchema),
      }),
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
        "Apply complete desired DSL to one explicit patcherId and wait for exact revision acknowledgement. Do not retry timeouts or baselineCaptured=false blindly; inspect live state first.",
      inputSchema: applyDslRequestSchema,
      outputSchema: z.object({
        patcherId: patcherIdSchema,
        scope: scopeSchema,
        baseRevision: revisionSchema,
        targetRevision: revisionSchema,
        operationCount: z.number().int().nonnegative(),
        acknowledgement: acknowledgementSchema,
        baselineCaptured: z.boolean(),
        baselineWarning: z.string().optional(),
        manualChangesMerged: z.number().int().nonnegative(),
        warnings: z.array(warningSchema),
      }),
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
          patcherId: request.patcherId,
          scope: result.plan.scope,
          baseRevision: result.plan.baseRevision,
          targetRevision: result.plan.targetRevision,
          operationCount: result.plan.operations.length,
          acknowledgement: result.acknowledgement,
          baselineCaptured: result.baselineCaptured,
          manualChangesMerged: result.manualChangesMerged,
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
