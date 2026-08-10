import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  LoadedObjectCatalog,
  searchObjectCatalog,
} from "../core/catalog-config.js";
import type { ObjectDatabase } from "../core/types.js";
import { MaxforgePatchService } from "./service.js";
import { PatchPlanTransport } from "../max/patch-protocol.js";

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

const structureTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{16}$/, "structure token must be 16 lowercase hex characters");

const patchInfoSchema = z.object({
  patcherId: patcherIdSchema.describe("Stable transport ID; use this instead of a window title"),
  scope: scopeSchema.describe("Managed namespace advertised by this patch"),
  instanceId: z.string().describe("Lifetime identity of this maxforge.sync object"),
  sessionId: z.string().describe("MCP registration-session identity"),
  revision: revisionSchema.nullable().describe("Live managed revision, or null before the first apply"),
  controller: z.boolean().describe("Whether this patch may create new top-level patches"),
  title: z.string().describe("Display-only Max window title"),
  filename: z.string().describe("Display-only Max document filename"),
  filepath: z.string().describe("Saved document path, or an empty string for an unsaved patch"),
  capabilities: z.array(z.string()),
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
  baseStructureToken: structureTokenSchema.optional(),
  operations: z.array(
    z.object({
      op: z.enum(["disconnect", "delete", "create", "set", "connect"]),
      targetPath: z.array(z.string()),
    }).passthrough()
  ).describe("Ordered native Max mutations; review these before apply"),
  rollbackOperations: z.array(
    z.object({
      op: z.enum(["disconnect", "delete", "create", "set", "connect"]),
      targetPath: z.array(z.string()),
    }).passthrough()
  ).optional().describe(
    "Reverse ordered mutations used by maxforge.sync after a partial apply failure"
  ),
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
  comment: z.string().optional(),
  attributes: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.array(z.union([z.string(), z.number()])),
  ])),
});

const snapshotConnectionSchema = z.object({
  targetPath: z.array(z.string()),
  source: snapshotEndpointSchema,
  destination: snapshotEndpointSchema,
  attributes: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.array(z.union([z.string(), z.number()])),
  ])),
});

const snapshotEventSchema = z.object({
  type: z.literal("maxforge.snapshot"),
  requestId: z.string(),
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  revision: revisionSchema.nullable(),
  structureToken: structureTokenSchema,
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

const catalogObjectSchema = z.object({
  name: z.string(),
  kind: z.enum(["built-in", "external", "abstraction"]),
  maxclass: z.string(),
  numinlets: z.number().int().nonnegative(),
  numoutlets: z.number().int().nonnegative(),
  outlettype: z.array(z.string()),
  dynamicPorts: z.boolean(),
  argumentPorts: z.boolean(),
  source: z.string(),
  paths: z.array(z.string()),
});

const catalogStatusSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string().optional(),
  }).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  configPath: z.string().nullable(),
  sources: z.array(z.string()),
  builtInObjectCount: z.number().int().nonnegative(),
  customObjectCount: z.number().int().nonnegative(),
  abstractionCount: z.number().int().nonnegative(),
});

const helpTopicSchema = z.enum(["workflow", "setup", "recovery", "safety"]);

const maxPatchPathSchema = z
  .string()
  .min(1)
  .max(2047)
  .refine(
    (path) => path.toLowerCase().endsWith(".maxpat"),
    "path must end with .maxpat"
  )
  .describe(
    "Absolute .maxpat path on the Max host, not necessarily on the MCP host"
  );

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
      "Exact previous complete DSL. Normally restored from persistent MCP state; required only when persistence was disabled or the matching state file is unavailable. Never guess or substitute empty state."
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

const snapshotChangeSchema = z.object({
  kind: z.enum([
    "box_added",
    "box_removed",
    "box_changed",
    "connection_added",
    "connection_changed",
    "connection_removed",
  ]),
  managed: z.boolean(),
}).passthrough();

const editReviewSchema = z.object({
  counts: z.object({
    boxesAdded: z.number().int().nonnegative(),
    boxesRemoved: z.number().int().nonnegative(),
    boxesChanged: z.number().int().nonnegative(),
    connectionsAdded: z.number().int().nonnegative(),
    connectionsRemoved: z.number().int().nonnegative(),
    connectionsChanged: z.number().int().nonnegative(),
  }),
  affectedManagedIds: z.array(z.string()),
  affectedUnmanagedRuntimeIds: z.array(z.string()),
  signals: z.array(z.object({
    kind: z.enum([
      "layout",
      "object_configuration",
      "annotation",
      "box_attributes",
      "ownership",
      "object_addition",
      "object_removal",
      "routing",
      "connection_attributes",
    ]),
    managed: z.boolean(),
    targetPath: z.array(z.string()),
    objectIds: z.array(z.string()),
    changeIndexes: z.array(z.number().int().nonnegative()),
    summary: z.string(),
  })),
  editClusters: z.array(z.object({
    id: z.string(),
    targetPath: z.array(z.string()),
    changeIndexes: z.array(z.number().int().nonnegative()),
    managedObjectIds: z.array(z.string()),
    unmanagedRuntimeIds: z.array(z.string()),
    observedRuntimeIds: z.array(z.string()),
    signalKinds: z.array(z.enum([
      "layout",
      "object_configuration",
      "annotation",
      "box_attributes",
      "ownership",
      "object_addition",
      "object_removal",
      "routing",
      "connection_attributes",
    ])),
    interpretationRisks: z.array(z.enum([
      "mixed_effects",
      "touches_unmanaged_state",
      "ownership_boundary_changed",
    ])),
    summary: z.string(),
  })),
  interpretationGuidance: z.object({
    mode: z.literal("evidence_only"),
    clarificationRecommendedFor: z.array(z.string()),
    instruction: z.string(),
  }),
});

const liveChangeReviewSchema = z.object({
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  comparisonAvailable: z.boolean(),
  managedChangeCount: z.number().int().nonnegative(),
  unmanagedChangeCount: z.number().int().nonnegative(),
  changes: z.array(snapshotChangeSchema),
  review: editReviewSchema,
  structureToken: structureTokenSchema,
  acknowledgedRevision: revisionSchema.optional(),
  observedManagedRevision: revisionSchema.optional(),
  canAdopt: z.boolean(),
  adoptionBlockedReason: z.string().optional(),
  conflicts: z.array(reconciliationConflictSchema),
  proposedWorkingDsl: z.string().optional(),
  snapshot: snapshotEventSchema,
});

const liveEditHistorySchema = z.object({
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  supported: z.boolean(),
  droppedEvents: z.number().int().nonnegative(),
  persistence: z.object({
    enabled: z.boolean(),
    projectId: z.string().nullable(),
    location: z.string().nullable(),
    warnings: z.array(z.string()),
  }),
  patchMetadata: z.array(z.object({
    projectId: z.string(),
    patcherId: patcherIdSchema,
    scope: scopeSchema,
    instanceId: z.string(),
    sessionId: z.string(),
    observedAt: z.string(),
    reason: z.enum(["registered", "saved"]),
    title: z.string(),
    filename: z.string(),
    filepath: z.string(),
  })),
  latestSequence: z.number().int().positive().nullable(),
  observations: z.array(z.object({
    sequence: z.number().int().positive(),
    sessionSequence: z.number().int().positive(),
    sessionId: z.string(),
    instanceId: z.string(),
    sessionStartedAt: z.string(),
    observedAt: z.string(),
    causes: z.array(z.enum([
      "patcher",
      "box",
      "line",
      "attribute",
      "unknown",
    ])),
    structureToken: structureTokenSchema,
    comparisonBasis: z.enum([
      "session_baseline",
      "previous_observation",
      "incomplete_after_drop",
      "unavailable",
    ]),
    changes: z.array(snapshotChangeSchema),
    review: editReviewSchema,
  })),
  limitations: z.array(z.string()),
});

const HELP_CONTENT = {
  workflow: {
    summary: "Safe desired-state workflow for inspecting and changing one live Max patch.",
    steps: [
      "Before using a project external or abstraction, call maxforge_catalog and confirm the loaded definition.",
      "After editing configured catalog files, call maxforge_reload_catalog and verify the replacement digest before compiling.",
      "Call maxforge_list_patches and copy the target patcherId and scope exactly.",
      "Call maxforge_inspect_patch before mutation; do not infer patch state from the screen or title.",
      "When edit observation is supported, call maxforge_get_live_edit_history to inspect ordered snapshot evidence before interpreting the current aggregate diff.",
      "If live edits exist, call maxforge_review_live_changes. Its signals are evidence of what changed, not certainty about why the human changed it.",
      "Interpret related changes together using review.editClusters. Treat interpretationRisks as prompts for reasoning, and use interpretationGuidance.clarificationRecommendedFor to identify clusters that may require a human question.",
      "To accept the current managed graph as the baseline, call maxforge_adopt_live_changes with the exact reviewed structure token. If a concrete next DSL is already ready, use maxforge_reconcile_patch instead and require canApply=true.",
      "After adoption, replace the working source with the returned workingDsl before compiling the next desired state.",
      "Send the complete desired DSL to maxforge_compile_plan and review every operation and warning.",
      "Send the same target and complete desired DSL to maxforge_apply_dsl. Set manualChanges to merge only after reconciliation succeeds.",
      "Treat the apply as successful only when acknowledgement.revision equals targetRevision, then inspect again.",
      "After every apply, retain returned workingDsl as the next complete source. While workingDslRequiredAsCurrent is true, include it as currentDsl in every preview and apply request until a successful apply realigns intent state.",
      "Use maxforge_save_patch explicitly after successful mutation; apply changes live state but does not save the document.",
    ],
    rules: [
      "DSL is complete desired state, not an imperative edit; omitted managed objects are removed.",
      "Never claim that a diff proves human intent. Ask only when unresolved interpretations would change the next action.",
      "Unmanaged additions are context and are not silently claimed by adoption.",
      "Ordinary compile/apply is rejected while the acknowledged graph still differs from the agent's last desired DSL due to preserved human edits.",
      "Apply binds the inspected live structure token; Max rejects the plan if the patch changes before native mutation.",
      "Never mutate an unlisted patcherId or a scope different from the registration.",
      "Never retry a timeout or baseline warning blindly; inspect live state first.",
    ],
    relatedTools: [
      "maxforge_catalog",
      "maxforge_reload_catalog",
      "maxforge_list_patches",
      "maxforge_inspect_patch",
      "maxforge_get_live_edit_history",
      "maxforge_review_live_changes",
      "maxforge_adopt_live_changes",
      "maxforge_reconcile_patch",
      "maxforge_compile_plan",
      "maxforge_apply_dsl",
      "maxforge_save_patch",
    ],
  },
  setup: {
    summary: "Runtime prerequisites for MCP-to-Max control.",
    steps: [
      "Run maxforge-mcp as an MCP stdio server with Node.js 20 or newer.",
      "Install the native maxforge.sync external separately; the npm package does not install the Max external.",
      "Set MAXFORGE_CONFIG before starting MCP when the project uses third-party externals or reusable abstractions.",
      "Keep the default ~/.maxforge per-port state file, or set MAXFORGE_STATE_FILE explicitly. Use the value off only when restart recovery is intentionally disabled.",
      "Open one controller patch containing maxforge.sync with controller enabled.",
      "Call maxforge_status and maxforge_catalog, then maxforge_list_patches to verify catalog and patch registration before creating or changing patches.",
    ],
    rules: [
      "Without MAXFORGE_WS_TOKEN the WebSocket bridge stays on 127.0.0.1:8766. Setting a URL-safe token publishes it on 0.0.0.0 and requires the same maxforge.sync @token.",
      "Do not write arbitrary output to MCP stdout; it is the protocol channel.",
      "New patch creation requires exactly one registered controller.",
      "maxforge_open_patch loads a .maxpat on the Max host and injects maxforge.sync; use it only for patches that do not already contain maxforge.sync.",
    ],
    relatedTools: [
      "maxforge_status",
      "maxforge_catalog",
      "maxforge_list_patches",
      "maxforge_create_patch",
      "maxforge_open_patch",
    ],
  },
  recovery: {
    summary: "Recovery rules for persisted state, manual edits, timeouts, and partial failures.",
    steps: [
      "After an MCP process restart, call maxforge_status and verify that the expected state file and managed revision were restored, then inspect the target.",
      "If persistence was disabled or its state file is unavailable, provide the exact previous complete DSL as currentDsl once.",
      "If status reports a pending scope after a timeout, reconnect that Max patch before compiling or applying; maxforge resolves the recorded base/target revisions instead of guessing.",
      "If inspect reports live changes, call maxforge_review_live_changes and treat its classified signals as evidence rather than intent.",
      "Use maxforge_get_live_edit_history when operation order or intermediate states could change the interpretation; account for droppedEvents and comparisonBasis.",
      "If accepted managed edits should become the new baseline, call maxforge_adopt_live_changes with the exact reviewed structure token, then replace the working source with its returned workingDsl.",
      "If a concrete next desired DSL is ready, call maxforge_reconcile_patch instead.",
      "If reconciliation reports canApply=true, apply the same DSL with manualChanges set to merge. Resolve reported conflicts explicitly instead of forcing a winner.",
      "After a timeout or transport error, call maxforge_status and maxforge_inspect_patch before deciding whether another apply is safe.",
      "If baselineCaptured is false, the apply still succeeded; do not repeat it solely to obtain a baseline.",
      "A dirty patch can only be closed by explicitly setting discard=true. Save it first if the changes must survive.",
    ],
    rules: [
      "Persistent state stores graphs and inspection baselines; a revision hash alone still cannot reconstruct either.",
      "Adoption rejects a stale structure token and advances revision without replaying edits that already exist in Max.",
      "Reconciliation preserves non-conflicting managed edits but never silently chooses between conflicting changes.",
      "Protocol v1 attempts generated reverse operations after a runtime mutation failure, but is not transactional; inspect before retrying while the revision remains unchanged.",
    ],
    relatedTools: [
      "maxforge_status",
      "maxforge_inspect_patch",
      "maxforge_get_live_edit_history",
      "maxforge_review_live_changes",
      "maxforge_adopt_live_changes",
      "maxforge_reconcile_patch",
      "maxforge_apply_dsl",
      "maxforge_save_patch",
      "maxforge_close_patch",
    ],
  },
  safety: {
    summary: "Ownership, identity, and mutation boundaries enforced by maxforge.",
    steps: [
      "Select targets only from maxforge_list_patches.",
      "Preview every nontrivial change with maxforge_compile_plan.",
      "Inspect after apply and separate managed from unmanaged changes.",
      "Review live changes before attributing intent or accepting them as desired state.",
    ],
    rules: [
      "Only exact maxforge_<scope>_obj_... scripting names belong to the managed scope.",
      "Titles and filenames are display metadata and are not stable identities.",
      "Unmanaged standalone edits do not block apply, but cords touching managed boxes do.",
      "Adoption applies only to the managed graph and requires the exact reviewed structure token.",
      "Apply-side inspection is bound to native mutation by a structure token; a later human edit rejects the plan instead of being overwritten.",
      "LAN mode uses token authentication over plaintext WebSocket. Keep it on a trusted LAN; it is not an Internet-facing security boundary.",
      "Catalog membership is compiler metadata and does not prove that Max can instantiate an external or find an abstraction.",
      "Save-as refuses an existing destination unless overwrite=true. Paths are resolved by the Max host, which matters in LAN mode.",
    ],
    relatedTools: [
      "maxforge_catalog",
      "maxforge_list_patches",
      "maxforge_compile_plan",
      "maxforge_inspect_patch",
      "maxforge_review_live_changes",
      "maxforge_adopt_live_changes",
    ],
  },
} as const;

export interface CreateMcpServerOptions {
  readonly service: MaxforgePatchService;
  readonly transport: PatchPlanTransport;
  readonly version: string;
  readonly catalog: LoadedObjectCatalog;
  readonly replaceObjectDatabase: (database: ObjectDatabase) => void;
  readonly reloadCatalog: () => Promise<LoadedObjectCatalog>;
}

export function createMaxforgeMcpServer(
  options: CreateMcpServerOptions
): McpServer {
  let currentCatalog = options.catalog;
  const server = new McpServer(
    {
      name: "maxforge",
      version: options.version,
    },
    {
      instructions:
        "Call maxforge_help with topic 'workflow' before the first live mutation. " +
        "Before using a project external or abstraction, confirm it with " +
        "maxforge_catalog; membership is metadata, not a Max runtime probe. " +
        "Always select patcherId and scope from maxforge_list_patches, inspect the " +
        "live patch, and review live differences before attributing human intent. " +
        "Adopt an accepted managed baseline only with the exact reviewed structure " +
        "token, or reconcile it with a concrete next complete DSL. After adoption, " +
        "use the returned workingDsl. Preview complete desired DSL with maxforge_compile_plan, " +
        "then pass the same complete DSL to maxforge_apply_dsl. Omitted managed " +
        "objects are deleted. Success requires acknowledgement.revision to equal " +
        "targetRevision and statePersisted to be true. Never retry a timeout or " +
        "baseline/state warning blindly. Persistent state normally survives MCP " +
        "restarts; currentDsl is only a fallback when that state is unavailable. " +
        "Call maxforge_help with topic 'recovery' on errors " +
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
        "Diagnose transport, persistent state, and unresolved applies. Use when no patch is listed, after restart, or after a timeout; connected clients are not usable targets until registered.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        bridge: z.object({
          host: z.string(),
          port: z.number().int().nonnegative(),
          connectedClients: z.number().int().nonnegative(),
          registeredPatches: z.array(patchInfoSchema),
          liveRevisions: z.record(z.string(), revisionSchema.nullable()),
          editHistoryPersistence: z.object({
            enabled: z.boolean(),
            projectId: z.string().nullable(),
            location: z.string().nullable(),
            warnings: z.array(z.string()),
          }),
        }),
        managedRevisions: z.record(z.string(), revisionSchema),
        inspectionBaselineScopes: z.array(z.string()),
        state: z.object({
          persistence: z.string().nullable(),
          pendingScopes: z.array(z.string()),
        }),
        catalog: catalogStatusSchema,
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
        state: options.service.getStateStatus(),
        catalog: catalogStatus(currentCatalog),
      };
      return toolResult(result);
    }
  );

  server.registerTool(
    "maxforge_catalog",
    {
      title: "Search Maxforge object catalog",
      description:
        "List configured third-party externals and abstractions, or search the effective catalog including built-ins. Use this before authoring DSL with project-specific objects; catalog membership describes compile metadata, not installation on the Max machine.",
      inputSchema: z.object({
        query: z.string().optional().describe(
          "Case-insensitive object-name or maxclass substring"
        ),
        includeBuiltins: z.boolean().optional().describe(
          "Include built-in Max objects; defaults to false"
        ),
        limit: z.number().int().min(1).max(200).optional().describe(
          "Maximum returned records; defaults to 50"
        ),
      }),
      outputSchema: z.object({
        catalog: catalogStatusSchema,
        totalMatches: z.number().int().nonnegative(),
        truncated: z.boolean(),
        objects: z.array(catalogObjectSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ query, includeBuiltins, limit }) => {
      const maximum = limit ?? 50;
      const matches = searchObjectCatalog(
        currentCatalog,
        query,
        includeBuiltins ?? false
      );
      return toolResult({
        catalog: catalogStatus(currentCatalog),
        totalMatches: matches.length,
        truncated: maximum < matches.length,
        objects: matches.slice(0, maximum),
      });
    }
  );

  server.registerTool(
    "maxforge_reload_catalog",
    {
      title: "Reload Maxforge object catalog",
      description:
        "Reload the configured object catalog from disk without restarting MCP. The compiler database and reported catalog switch together only after the complete replacement validates successfully.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        previous: catalogStatusSchema,
        catalog: catalogStatusSchema,
        changed: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const previous = currentCatalog;
        const replacement = await options.reloadCatalog();
        options.replaceObjectDatabase(replacement.database);
        currentCatalog = replacement;
        return toolResult({
          previous: catalogStatus(previous),
          catalog: catalogStatus(replacement),
          changed: previous.digest !== replacement.digest,
        });
      } catch (error) {
        return toolError(error);
      }
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
    "maxforge_open_patch",
    {
      title: "Open Max patch",
      description:
        "Open an existing .maxpat on the Max host, inject a maxforge.sync object, and wait for registration. The patch becomes dirty because the bridge object is added. Refuses files that already contain maxforge.sync.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe(
          "Unique stable ID assigned to the opened patch"
        ),
        scope: scopeSchema.describe("Managed scope assigned to the opened patch"),
        title: z.string().min(1).max(256).describe("Visible patch window title"),
        path: maxPatchPathSchema,
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
        const patch = await options.transport.openPatch(request);
        return toolResult({ patch });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_save_patch",
    {
      title: "Save Max patch",
      description:
        "Save a registered patch. Omit path only for a patch already saved on disk. Supplying path performs save-as on the Max host and refuses an existing destination unless overwrite=true.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope of the target patch"),
        path: maxPatchPathSchema.optional().describe(
          "Absolute destination on the Max host; omit to save the existing file"
        ),
        overwrite: z.boolean().optional().describe(
          "Allow replacing an existing save-as destination; defaults to false"
        ),
      }),
      outputSchema: z.object({
        saved: z.object({
          type: z.literal("maxforge.patch.saved"),
          requestId: z.string(),
          patcherId: patcherIdSchema,
          scope: scopeSchema,
          filename: z.string(),
          filepath: z.string(),
          dirty: z.literal(false),
        }),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (request) => {
      try {
        const saved = await options.transport.savePatch(request);
        return toolResult({ saved });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_close_patch",
    {
      title: "Close Max patch",
      description:
        "Close a registered top-level Max patch. A dirty patch is rejected unless discard=true is explicitly supplied; save first to preserve changes.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope of the target patch"),
        discard: z.boolean().optional().describe(
          "Explicitly discard dirty changes; defaults to false"
        ),
      }),
      outputSchema: z.object({
        closing: z.object({
          type: z.literal("maxforge.patch.closing"),
          requestId: z.string(),
          patcherId: patcherIdSchema,
          scope: scopeSchema,
          discarded: z.boolean(),
        }),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (request) => {
      try {
        const closing = await options.transport.closePatch(request);
        return toolResult({ closing });
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
        changes: z.array(snapshotChangeSchema),
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
    "maxforge_review_live_changes",
    {
      title: "Review human edits in a live Max patch",
      description:
        "Turn live changes since the last acknowledged apply into neutral, structured evidence for agent intent inference. Reports exact before/after changes, affected managed identities, routing/layout/configuration signals, correlated edit clusters, interpretation risks, and whether the reviewed state can be safely adopted. This tool never claims why the human edited the patch and never mutates Max.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope of the target patch"),
      }),
      outputSchema: liveChangeReviewSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope }) => {
      try {
        const result = await options.service.reviewLiveChanges(patcherId, scope);
        return toolResult({ patcherId, scope, ...result });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_get_live_edit_history",
    {
      title: "Get ordered live-edit evidence",
      description:
        "Read bounded, ordered, debounced snapshot evidence captured by maxforge.sync while the patch was edited. Returns per-observation structural differences, neutral edit reviews, and notification cause categories. It does not reconstruct Max undo actions or prove human intent. Check supported, droppedEvents, and comparisonBasis before relying on chronology.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope of the target patch"),
        afterSequence: z.number().int().nonnegative().optional().describe(
          "Return only observations after this previously seen sequence"
        ),
      }),
      outputSchema: liveEditHistorySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope, afterSequence }) => {
      try {
        const history = options.service.getLiveEditHistory(
          patcherId,
          scope,
          afterSequence
        );
        return toolResult({ ...history });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_adopt_live_changes",
    {
      title: "Adopt reviewed human edits",
      description:
        "Accept the exact reviewed live structure as the next managed and agent-intent baseline without replaying the human's structural edits. Requires the structure token returned by maxforge_review_live_changes. Safe managed edits advance the native revision with a zero-operation, token-bound plan; conflicts and unrepresentable protocol-v1 patch-cord metadata are rejected. Returns lossless workingDsl for the next desired-state edit.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope of the target patch"),
        expectedStructureToken: structureTokenSchema.describe(
          "Exact structureToken returned by the immediately preceding live-change review"
        ),
      }),
      outputSchema: liveChangeReviewSchema.extend({
        previousRevision: revisionSchema,
        adoptedRevision: revisionSchema,
        revisionAdvanced: z.boolean(),
        acknowledgement: acknowledgementSchema.optional(),
        statePersisted: z.boolean(),
        stateWarning: z.string().optional(),
        workingDsl: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (request) => {
      try {
        const result = await options.service.adoptLiveChanges(request);
        return toolResult({
          patcherId: request.patcherId,
          scope: request.scope,
          ...result,
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
        "Preview a three-way merge of the agent's previous desired graph, the current live patch, and complete next desired DSL. Returns structured conflicts and never mutates Max.",
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
        statePersisted: z.boolean(),
        stateWarning: z.string().optional(),
        workingDsl: z.string(),
        workingDslRequiredAsCurrent: z.boolean(),
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
          statePersisted: result.statePersisted,
          workingDsl: result.workingDsl,
          workingDslRequiredAsCurrent: result.workingDslRequiredAsCurrent,
          ...(result.baselineWarning
            ? { baselineWarning: result.baselineWarning }
            : {}),
          ...(result.stateWarning
            ? { stateWarning: result.stateWarning }
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

function catalogStatus(catalog: LoadedObjectCatalog) {
  const customNames = new Set(catalog.customObjects.map(({ name }) => name));
  return {
    project: catalog.project ?? null,
    digest: catalog.digest,
    configPath: catalog.configPath ?? null,
    sources: [...catalog.sources],
    builtInObjectCount: Object.keys(catalog.database).filter(
      (name) => !customNames.has(name)
    ).length,
    customObjectCount: catalog.customObjects.length,
    abstractionCount: catalog.customObjects.filter(
      ({ kind }) => kind === "abstraction"
    ).length,
  };
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
