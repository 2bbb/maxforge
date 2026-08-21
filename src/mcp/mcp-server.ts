import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  LoadedObjectCatalog,
  searchObjectCatalog,
} from "../core/catalog-config.js";
import type { ObjectDatabase } from "../core/types.js";
import { MaxforgePatchService } from "./service.js";
import { PatchPlanTransport } from "../max/patch-protocol.js";
import type { BrokerStatus } from "./broker-protocol.js";

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
  externalVersion: z.string().describe(
    "Version embedded in the maxforge.sync binary actually loaded by Max"
  ),
  versionCompatible: z.boolean().describe(
    "Whether the loaded maxforge.sync version exactly matches this MCP runtime"
  ),
  capabilities: z.array(z.string()),
});

const warningSchema = z.object({
  code: z.string().describe("Stable maxforge warning code"),
  message: z.string(),
  line: z.number().int().positive().optional(),
});

const patchOperationSchema = z.object({
  op: z.enum(["disconnect", "delete", "create", "set", "connect"]),
  targetPath: z.array(z.string()),
}).passthrough();

const patchPlanSchema = z.object({
  protocolVersion: z.literal(1),
  scope: scopeSchema,
  baseRevision: revisionSchema,
  targetRevision: revisionSchema,
  baseStructureToken: structureTokenSchema.optional(),
  operations: z.array(patchOperationSchema).describe(
    "Ordered native Max mutations; review these before apply"
  ),
  rollbackOperations: z.array(patchOperationSchema).optional().describe(
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

const sourceRefSchema = revisionSchema.describe(
  "SHA-256 reference to an exact retained complete working source"
);

const receiptIdSchema = z.string().uuid().describe(
  "One-time prepared change receipt returned by maxforge_prepare_change"
);

const prepareChangeRequestSchema = z.object({
  patcherId: patcherIdSchema.describe(
    "Registered target Max patch ID copied from maxforge_list_patches; never infer it from a title"
  ),
  scope: scopeSchema.describe(
    "Exact managed scope advertised by the selected patch"
  ),
  desiredDsl: z.string().min(1).optional().describe(
    "Complete desired maxforge DSL state, sent once for a new source or broad rewrite"
  ),
  baseSourceRef: sourceRefSchema.optional().describe(
    "Exact retained source to edit without retransmitting the complete DSL"
  ),
  edits: z.array(z.object({
    startLine: z.number().int().positive().describe(
      "1-based inclusive start boundary"
    ),
    endLine: z.number().int().positive().describe(
      "1-based exclusive end boundary; equal to startLine for insertion"
    ),
    replacement: z.string(),
  })).min(1).max(64).optional(),
  currentDsl: z.string().optional().describe(
    "Recovery-only exact previous complete DSL when retained broker state is unavailable"
  ),
  currentSourceRef: sourceRefSchema.optional().describe(
    "Retained exact current source to use without retransmitting currentDsl"
  ),
  manualChanges: z
    .enum(["reject", "merge"])
    .optional()
    .describe(
      "Defaults to reject. Use merge only after reviewing managed live edits."
    ),
  expectedStructureToken: structureTokenSchema.optional().describe(
    "Exact token from the latest inspection or live-change review for this target. When omitted, preparation requests one fresh inspection."
  ),
}).superRefine((value, context) => {
  const inline = value.desiredDsl !== undefined;
  const sourceEdit = value.baseSourceRef !== undefined || value.edits !== undefined;
  if (inline === sourceEdit) {
    context.addIssue({
      code: "custom",
      message: "Provide either desiredDsl or both baseSourceRef and edits",
    });
  }
  if (sourceEdit && (value.baseSourceRef === undefined || value.edits === undefined)) {
    context.addIssue({
      code: "custom",
      message: "baseSourceRef and edits must be provided together",
    });
  }
  if (value.currentDsl !== undefined && value.currentSourceRef !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Provide currentDsl or currentSourceRef, not both",
    });
  }
  if (sourceEdit && (value.currentDsl !== undefined || value.currentSourceRef !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "Source-edit mode already uses baseSourceRef as exact currentDsl",
    });
  }
});

const operationCountsSchema = z.object({
  disconnect: z.number().int().nonnegative(),
  delete: z.number().int().nonnegative(),
  create: z.number().int().nonnegative(),
  set: z.number().int().nonnegative(),
  connect: z.number().int().nonnegative(),
});

const patchInspectionSummarySchema = z.object({
  title: z.string(),
  filename: z.string(),
  filepath: z.string(),
  dirty: z.boolean(),
  locked: z.boolean(),
  presentation: z.boolean(),
  boxCount: z.number().int().nonnegative(),
  connectionCount: z.number().int().nonnegative(),
});

const postApplyVerificationSchema = z.object({
  revision: revisionSchema,
  structureToken: structureTokenSchema,
  boxCount: z.number().int().nonnegative(),
  connectionCount: z.number().int().nonnegative(),
});

const applyDslTimingsSchema = z.object({
  preflightMs: z.number().nonnegative(),
  pendingStatePersistenceMs: z.number().nonnegative(),
  nativeApplyMs: z.number().nonnegative(),
  postApplyInspectionMs: z.number().nonnegative(),
  finalStatePersistenceMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
});

const reconciliationConflictSchema = z.object({
  kind: z.string(),
  targetPath: z.array(z.string()),
  id: z.string().optional(),
  field: z.string().optional(),
  message: z.string(),
}).passthrough();

const preparedChangeSchema = z.object({
  canApply: z.boolean(),
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  receiptId: receiptIdSchema.optional(),
  baseRevision: revisionSchema.optional(),
  targetRevision: revisionSchema.optional(),
  structureToken: structureTokenSchema,
  operationCount: z.number().int().nonnegative().optional(),
  operationCounts: operationCountsSchema.optional(),
  destructiveOperations: z.array(patchOperationSchema).optional(),
  replacements: z.array(z.object({
    targetPath: z.array(z.string()),
    id: z.string(),
  })).optional(),
  comparisonAvailable: z.boolean().optional(),
  managedChangeCount: z.number().int().nonnegative().optional(),
  unmanagedChangeCount: z.number().int().nonnegative().optional(),
  conflicts: z.array(reconciliationConflictSchema),
  warnings: z.array(warningSchema),
  sourceRef: sourceRefSchema.optional(),
  sourceCharacters: z.number().int().nonnegative().optional(),
  workingDslRequiredAsCurrent: z.boolean().optional(),
  manualChangesMerged: z.number().int().nonnegative().optional(),
  prepareMs: z.number().nonnegative(),
});

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
  })).optional(),
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
  changes: z.array(snapshotChangeSchema).optional(),
  review: editReviewSchema,
  structureToken: structureTokenSchema,
  acknowledgedRevision: revisionSchema.optional(),
  observedManagedRevision: revisionSchema.optional(),
  canAdopt: z.boolean(),
  adoptionBlockedReason: z.string().optional(),
  conflicts: z.array(reconciliationConflictSchema),
  proposedWorkingDsl: z.string().optional(),
  snapshot: snapshotEventSchema.optional(),
});

const adoptedChangeSchema = z.object({
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  previousRevision: revisionSchema,
  adoptedRevision: revisionSchema,
  revisionAdvanced: z.boolean(),
  acknowledgement: acknowledgementSchema.optional(),
  structureToken: structureTokenSchema,
  managedChangeCount: z.number().int().nonnegative(),
  unmanagedChangeCount: z.number().int().nonnegative(),
  statePersisted: z.boolean(),
  stateWarning: z.string().optional(),
  sourceRef: sourceRefSchema,
  sourceCharacters: z.number().int().nonnegative(),
});

const pendingApplyInspectionSchema = z.object({
  patcherId: patcherIdSchema,
  scope: scopeSchema,
  baseRevision: revisionSchema,
  targetRevision: revisionSchema,
  intentRevision: revisionSchema,
  liveRevision: revisionSchema,
  liveState: z.enum(["base", "target", "other"]),
  structureToken: structureTokenSchema,
  comparisonAvailable: z.boolean(),
  managedChangeCount: z.number().int().nonnegative(),
  unmanagedChangeCount: z.number().int().nonnegative(),
  changes: z.array(snapshotChangeSchema),
  review: editReviewSchema,
  baseWorkingDsl: z.string().optional(),
  targetWorkingDsl: z.string(),
  intentWorkingDsl: z.string(),
  supersededApply: z.object({
    baseRevision: revisionSchema,
    targetRevision: revisionSchema,
    intentRevision: revisionSchema,
    targetWorkingDsl: z.string(),
    intentWorkingDsl: z.string(),
  }).optional(),
  snapshot: snapshotEventSchema,
});

const patchHistoryIdentitySchema = z.object({
  patcherId: patcherIdSchema,
  scope: scopeSchema,
});

const patchHistoryIdentityDecisionSchema = z.object({
  action: z.enum(["rekey", "merge", "forget"]),
  source: patchHistoryIdentitySchema,
  target: patchHistoryIdentitySchema.optional(),
  reason: z.string(),
  resolvedAt: z.string(),
});

const patchHistoryIdentityStatusSchema = z.object({
  projectId: z.string(),
  requested: patchHistoryIdentitySchema,
  canonical: patchHistoryIdentitySchema,
  known: z.boolean(),
  forgotten: z.boolean(),
  aliases: z.array(patchHistoryIdentitySchema),
  decisions: z.array(patchHistoryIdentityDecisionSchema),
});

const projectHistoryErasureSchema = z.object({
  projectId: z.string(),
  location: z.string(),
  filesDeleted: z.number().int().nonnegative(),
  bytesDeleted: z.number().int().nonnegative(),
  retainedObservationsCleared: z.number().int().nonnegative(),
  directoryRemoved: z.boolean(),
  physicalDataDeleted: z.boolean(),
  secureOverwriteGuaranteed: z.literal(false),
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
  identity: patchHistoryIdentityStatusSchema.nullable(),
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
      "Before any mutation, require the target's versionCompatible field to be true. externalVersion is reported by the maxforge.sync binary loaded in Max and must exactly match bridge.expectedExternalVersion.",
      "Call maxforge_inspect_patch before mutation; start with summary detail and request full only when complete surrounding topology is needed. Copy its structureToken into apply so the same full snapshot is not requested twice. Do not infer patch state from the screen or title.",
      "When edit observation is supported, call maxforge_get_live_edit_history to inspect ordered snapshot evidence before interpreting the current aggregate diff.",
      "If live edits exist, call maxforge_review_live_changes. Its signals are evidence of what changed, not certainty about why the human changed it.",
      "Interpret related changes together using review.editClusters. Treat interpretationRisks as prompts for reasoning, and use interpretationGuidance.clarificationRecommendedFor to identify clusters that may require a human question.",
      "To accept the current managed graph as the baseline, call maxforge_adopt_live_changes with the exact reviewed structure token. If a concrete next DSL is already ready, prepare it with manualChanges set to merge and require canApply=true.",
      "After adoption, retain returned sourceRef and query or edit that broker-held source instead of copying complete DSL through agent context.",
      "Send complete desired DSL once to maxforge_prepare_change with the exact inspected structure token. Review warnings, every destructive operation, and every replacement; bulk create/connect/rollback operations remain behind the receipt.",
      "Apply only the returned receiptId with maxforge_apply_prepared_change. Do not resend or recompile the DSL.",
      "Treat native mutation as acknowledged only when acknowledgement.revision equals targetRevision. When verification is present, require verification.revision to match; when it is absent or baselineCaptured is false, inspect before further mutation instead of retrying the apply.",
      "After apply, retain sourceRef rather than copying complete DSL through agent context. Call maxforge_get_working_source only when the exact source is needed for authoring or recovery. While workingDslRequiredAsCurrent is true, pass that fetched exact source as currentDsl to the next prepare call until a successful apply realigns intent state.",
      "Use maxforge_save_patch explicitly after successful mutation; apply changes live state but does not save the document.",
    ],
    rules: [
      "DSL is complete desired state, not an imperative edit; omitted managed objects are removed.",
      "Never claim that a diff proves human intent. Ask only when unresolved interpretations would change the next action.",
      "Unmanaged additions are context and are not silently claimed by adoption.",
      "Ordinary compile/apply is rejected while the acknowledged graph still differs from the agent's last desired DSL due to preserved human edits.",
      "Apply binds the inspected live structure token; Max rejects the plan if the patch changes before native mutation.",
      "Never mutate an unlisted patcherId or a scope different from the registration.",
      "Do not mutate when versionCompatible is false. Install the matching external in an explicit Max package or project search path, remove stale duplicate binaries, restart Max, and list patches again.",
      "Never retry a timeout or baseline warning blindly; inspect live state first.",
    ],
    relatedTools: [
      "maxforge_catalog",
      "maxforge_reload_catalog",
      "maxforge_list_patches",
      "maxforge_inspect_patch",
      "maxforge_inspect_pending_apply",
      "maxforge_recover_pending_apply",
      "maxforge_get_live_edit_history",
      "maxforge_review_live_changes",
      "maxforge_adopt_live_changes",
      "maxforge_prepare_change",
      "maxforge_apply_prepared_change",
      "maxforge_get_working_source",
      "maxforge_save_patch",
    ],
  },
  setup: {
    summary: "Runtime prerequisites for MCP-to-Max control.",
    steps: [
      "Run maxforge-mcp as an MCP stdio server with Node.js 20 or newer.",
      "Each stdio process attaches to one detached project broker. The first frontend starts it; closing that frontend does not stop a broker that still has MCP or Max clients.",
      "Install the native maxforge.sync external separately; the npm package does not install the Max external.",
      "Set MAXFORGE_CONFIG before starting MCP when the project uses third-party externals or reusable abstractions.",
      "Declare a stable project.id in MAXFORGE_CONFIG to scope managed state and persistent edit history. Do not reuse one id for unrelated projects.",
      "Keep the default project-scoped state/history paths, or set MAXFORGE_STATE_FILE and MAXFORGE_EDIT_HISTORY_DIR explicitly. Use off only when persistence is intentionally disabled.",
      "Open one controller patch containing maxforge.sync with controller enabled.",
      "Call maxforge_status and maxforge_catalog, then maxforge_list_patches to verify catalog and patch registration before creating or changing patches.",
    ],
    rules: [
      "Without MAXFORGE_WS_TOKEN the WebSocket bridge stays on 127.0.0.1:8766. Setting a URL-safe token publishes it on 0.0.0.0 and requires the same maxforge.sync @token.",
      "Use maxforge broker status/stop/restart for explicit lifecycle or package upgrades. Stop and restart refuse connected clients unless --force is explicit, and pending native operations are never interrupted.",
      "Do not write arbitrary output to MCP stdout; it is the protocol channel.",
      "New patch creation requires exactly one registered controller.",
      "maxforge_open_patch loads a .maxpat on the Max host and injects maxforge.sync; use it only for patches that do not already contain maxforge.sync.",
      "Saved file paths are locators and metadata, not patch identities; always route by listed patcherId and scope.",
      "A patch filepath does not identify the external binary Max loaded. Use externalVersion and versionCompatible; colocating an external beside a patch is not proof that Max resolved it.",
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
      "After a broker restart, call maxforge_status and verify that the expected state file and managed revision were restored, then inspect the target. Restarting only a stdio frontend does not restart broker state.",
      "If persistence was disabled or its state file is unavailable, provide the exact previous complete DSL as currentDsl once.",
      "If status reports a pending scope after a timeout, reconnect that Max patch before compiling or applying; maxforge resolves the recorded base/target revisions instead of guessing.",
      "If the pending scope reports a third live revision, call maxforge_inspect_pending_apply. Rebase only with its exact live revision and structure token plus trusted complete current DSL; never delete the state file or guess the source.",
      "If inspect reports live changes, call maxforge_review_live_changes and treat its classified signals as evidence rather than intent.",
      "Use maxforge_get_live_edit_history when operation order or intermediate states could change the interpretation; account for droppedEvents and comparisonBasis.",
      "If saved-path warnings remain ambiguous, inspect both identities with maxforge_get_patch_history_identity. Only after the human confirms the relationship may you close the source and call maxforge_resolve_patch_history_identity.",
      "If broker startup reports an edit-history writer lease, inspect maxforge_status.broker first. A replacement broker automatically recovers a valid lease whose recorded process is dead, but never replaces a live or malformed lease.",
      "If accepted managed edits should become the new baseline, call maxforge_adopt_live_changes with the exact reviewed structure token, then retain its sourceRef.",
      "If a concrete next desired DSL is ready, call maxforge_prepare_change with manualChanges set to merge instead.",
      "If preparation reports canApply=true, apply its receipt. Resolve reported conflicts explicitly instead of forcing a winner.",
      "After a timeout or transport error, call maxforge_status and maxforge_inspect_patch before deciding whether another apply is safe.",
      "If baselineCaptured is false, the apply still succeeded; do not repeat it solely to obtain a baseline.",
      "A dirty patch can only be closed by explicitly setting discard=true. Save it first if the changes must survive.",
    ],
    rules: [
      "Persistent state stores graphs and inspection baselines; a revision hash alone still cannot reconstruct either.",
      "Adoption rejects a stale structure token and advances revision without replaying edits that already exist in Max.",
      "Reconciliation preserves non-conflicting managed edits but never silently chooses between conflicting changes.",
      "History rekey changes one closed identity to an unused ID; merge combines a closed source with a known target; forget only hides Agent-facing history and does not physically erase NDJSON.",
      "Use maxforge_erase_project_history only after the human explicitly requests deletion, every Max client is disconnected, and the exact project ID and confirmation phrase have been checked. It deletes retained edit evidence and the identity ledger, not Max files, DSL sources, project config, or the desired-state cache.",
      "History identity decisions never rewrite live maxforge.sync routing, never cross scopes, and must not be inferred from a filepath alone.",
      "Persistent edit history permits one project broker writer per history directory. Per-session maxforge-mcp frontends attach to that broker; the writer lease is not multi-writer synchronization.",
      "Protocol v1 attempts generated reverse operations after a runtime mutation failure, but is not transactional; inspect before retrying while the revision remains unchanged.",
    ],
    relatedTools: [
      "maxforge_status",
      "maxforge_inspect_patch",
      "maxforge_inspect_pending_apply",
      "maxforge_recover_pending_apply",
      "maxforge_get_live_edit_history",
      "maxforge_get_patch_history_identity",
      "maxforge_resolve_patch_history_identity",
      "maxforge_erase_project_history",
      "maxforge_review_live_changes",
      "maxforge_adopt_live_changes",
      "maxforge_prepare_change",
      "maxforge_apply_prepared_change",
      "maxforge_save_patch",
      "maxforge_close_patch",
    ],
  },
  safety: {
    summary: "Ownership, identity, and mutation boundaries enforced by maxforge.",
    steps: [
      "Select targets only from maxforge_list_patches.",
      "Require versionCompatible=true before every mutation; version mismatch is diagnostic-only until Max is restarted with the matching external.",
      "Prepare every nontrivial change with maxforge_prepare_change and review its compact destructive summary.",
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
      "maxforge_prepare_change",
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
  readonly getCatalog: () => LoadedObjectCatalog;
  readonly setCatalog: (catalog: LoadedObjectCatalog) => void;
  readonly replaceObjectDatabase: (database: ObjectDatabase) => void;
  readonly reloadCatalog: () => Promise<LoadedObjectCatalog>;
  readonly getBrokerStatus?: () => BrokerStatus;
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
        "Before using a project external or abstraction, confirm it with " +
        "maxforge_catalog; membership is metadata, not a Max runtime probe. " +
        "Always select patcherId and scope from maxforge_list_patches, inspect the " +
        "reported externalVersion, require versionCompatible=true, inspect the " +
        "live patch, and review live differences before attributing human intent. " +
        "Adopt an accepted managed baseline only with the exact reviewed structure " +
        "token, or prepare a concrete next complete DSL with manualChanges=merge. " +
        "Send complete desired DSL once to maxforge_prepare_change, review its " +
        "destructive summary, then pass only its receiptId to " +
        "maxforge_apply_prepared_change. Omitted managed " +
        "objects are deleted. Success requires acknowledgement.revision to equal " +
        "targetRevision and statePersisted to be true. Never retry a timeout or " +
        "baseline/state warning blindly. Persistent state normally survives MCP " +
        "restarts; currentDsl is only a fallback when that state is unavailable. " +
        "For an ambiguous pending scope, call maxforge_inspect_pending_apply " +
        "and use token-bound recovery instead of deleting persistent state. " +
        "Call maxforge_help with topic 'recovery' on errors " +
        "or managed manual drift. Keep sourceRef after apply and fetch complete " +
        "DSL with maxforge_get_working_source only when needed.",
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
        broker: z.object({
          state: z.enum(["starting", "ready", "failed", "draining"]),
          brokerVersion: z.string(),
          pid: z.number().int().positive(),
          mcpClients: z.number().int().nonnegative(),
          maxClients: z.number().int().nonnegative(),
          pendingOperations: z.number().int().nonnegative(),
          idleTimeoutMs: z.number().int().nonnegative(),
          ownerPort: z.number().int().min(1024).max(65535),
          error: z.string().optional(),
          ownership: z.object({
            state: z.enum([
              "unlocked",
              "owned",
              "held_by_other_process",
              "stale",
              "malformed",
            ]),
            path: z.string(),
            identity: z.string().nullable(),
            pid: z.number().int().positive().nullable(),
            acquiredAt: z.string().nullable(),
          }),
        }).nullable(),
        bridge: z.object({
          host: z.string(),
          port: z.number().int().nonnegative(),
          expectedExternalVersion: z.string(),
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
        broker: options.getBrokerStatus?.() ?? null,
        bridge: options.transport.getStatus(),
        managedRevisions: options.service.getManagedRevisions(),
        inspectionBaselineScopes: options.service.getBaselineScopes(),
        state: options.service.getStateStatus(),
        catalog: catalogStatus(options.getCatalog()),
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
        options.getCatalog(),
        query,
        includeBuiltins ?? false
      );
      return toolResult({
        catalog: catalogStatus(options.getCatalog()),
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
        const previous = options.getCatalog();
        const replacement = await options.reloadCatalog();
        if (previous.project?.id !== replacement.project?.id) {
          throw new Error(
            "project.id cannot change during catalog reload; restart maxforge-mcp to switch persistence namespace"
          );
        }
        options.replaceObjectDatabase(replacement.database);
        options.setCatalog(replacement);
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
        "List registered Max patches and the loaded native external version. Always copy patcherId and scope from this result and require versionCompatible=true before mutation; never target a patch by title or filename.",
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
        "Read live Max patch state without using the screen. Summary detail returns revision, structure token, counts, and drift; full detail additionally returns every box and connection. Inspection does not accept or reset the baseline.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Managed patch scope to inspect"),
        detail: z.enum(["summary", "full"])
          .optional()
          .default("summary")
          .describe(
            "summary omits the complete snapshot while retaining revision, token, counts, and changes; full includes every live box and connection"
          ),
      }),
      outputSchema: z.object({
        patcherId: patcherIdSchema,
        scope: scopeSchema,
        revision: revisionSchema.nullable(),
        structureToken: structureTokenSchema,
        patch: patchInspectionSummarySchema,
        comparisonAvailable: z.boolean(),
        managedChangeCount: z.number().int().nonnegative(),
        unmanagedChangeCount: z.number().int().nonnegative(),
        changes: z.array(snapshotChangeSchema),
        snapshot: snapshotEventSchema.optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope, detail }) => {
      try {
        const result = await options.service.inspectPatch(patcherId, scope);
        const patch = result.snapshot.patcher;
        const response = {
          patcherId,
          scope,
          revision: result.snapshot.revision,
          structureToken: result.snapshot.structureToken,
          patch: {
            title: patch.title,
            filename: patch.filename,
            filepath: patch.filepath,
            dirty: patch.dirty,
            locked: patch.locked,
            presentation: patch.presentation,
            boxCount: patch.boxes.length,
            connectionCount: patch.connections.length,
          },
          comparisonAvailable: result.comparisonAvailable,
          managedChangeCount: result.managedChangeCount,
          unmanagedChangeCount: result.unmanagedChangeCount,
          changes: result.changes,
          ...(detail === "full" ? { snapshot: result.snapshot } : {}),
        };
        return toolResult(response, responseWithout(response, ["snapshot"]));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_inspect_pending_apply",
    {
      title: "Inspect an unresolved Max apply",
      description:
        "Read an unresolved apply without auto-clearing it. Returns persisted base, target, and intent revisions and DSL alongside the exact current live revision, structure token, and structural evidence. Use this when a third live revision makes ordinary compile, review, or reconcile calls ambiguous.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope with a pending apply"),
      }),
      outputSchema: pendingApplyInspectionSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope }) => {
      try {
        return toolResult({
          ...await options.service.inspectPendingApply(patcherId, scope),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_recover_pending_apply",
    {
      title: "Rebase an unresolved apply onto live Max state",
      description:
        "Explicitly replace an ambiguous pending apply with the exact inspected third live revision. Requires complete current DSL whose revision equals Max plus the immediately preceding revision and structure token. Reconstructs and losslessly serializes live managed state before changing the baseline, and preserves superseded apply evidence across acknowledgement loss.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope with a pending apply"),
        action: z.literal("rebase_live"),
        expectedLiveRevision: revisionSchema.describe(
          "Exact liveRevision from maxforge_inspect_pending_apply"
        ),
        expectedStructureToken: structureTokenSchema.describe(
          "Exact structureToken from maxforge_inspect_pending_apply"
        ),
        currentDsl: z.string().min(1).describe(
          "Complete trusted DSL whose revision exactly matches expectedLiveRevision"
        ),
      }),
      outputSchema: pendingApplyInspectionSchema.extend({
        action: z.literal("rebase_live"),
        previousLiveRevision: revisionSchema,
        managedRevision: revisionSchema,
        revisionAdvanced: z.boolean(),
        acknowledgement: acknowledgementSchema.optional(),
        statePersisted: z.boolean(),
        stateWarning: z.string().optional(),
        workingDsl: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (request) => {
      try {
        return toolResult({
          ...await options.service.recoverPendingApply(request),
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
        detail: z.enum(["summary", "full"])
          .optional()
          .default("summary")
          .describe(
            "summary omits the full snapshot, raw changes, signal duplicates, and proposed complete DSL; full returns all evidence"
          ),
      }),
      outputSchema: liveChangeReviewSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope, detail }) => {
      try {
        const result = await options.service.reviewLiveChanges(patcherId, scope);
        if (detail === "full") {
          return toolResult({ patcherId, scope, ...result });
        }
        const { signals: _signals, ...compactReview } = result.review;
        return toolResult({
          patcherId,
          scope,
          comparisonAvailable: result.comparisonAvailable,
          managedChangeCount: result.managedChangeCount,
          unmanagedChangeCount: result.unmanagedChangeCount,
          review: compactReview,
          structureToken: result.structureToken,
          ...(result.acknowledgedRevision
            ? { acknowledgedRevision: result.acknowledgedRevision }
            : {}),
          ...(result.observedManagedRevision
            ? { observedManagedRevision: result.observedManagedRevision }
            : {}),
          canAdopt: result.canAdopt,
          ...(result.adoptionBlockedReason
            ? { adoptionBlockedReason: result.adoptionBlockedReason }
            : {}),
          conflicts: result.conflicts,
        });
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
        "Read bounded, ordered, debounced snapshot evidence captured by maxforge.sync while the patch was edited. Returns session-scoped structural differences, neutral edit reviews, persistence health, and saved-path locator metadata. It does not reconstruct Max undo actions or prove human intent. Check supported, persistence, droppedEvents, and comparisonBasis before relying on chronology.",
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
    "maxforge_get_patch_history_identity",
    {
      title: "Inspect persistent patch history identity",
      description:
        "Read the project-scoped logical identity used to locate retained edit evidence, including canonical identity, aliases, explicit decisions, and logical-forget state. This works for disconnected historical identities when persistent edit history is enabled. Saved paths remain locator metadata and are never promoted to identity.",
      inputSchema: patchHistoryIdentitySchema,
      outputSchema: patchHistoryIdentityStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope }) => {
      try {
        return toolResult({
          ...options.service.getPatchHistoryIdentity(patcherId, scope),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_resolve_patch_history_identity",
    {
      title: "Resolve persistent patch history identity",
      description:
        "Append an explicit project-scoped history decision. rekey moves one closed historical identity to an unused ID; merge combines one closed source into an already known canonical target after the human confirms they are the same patch; forget hides a closed identity group from Agent-facing history. This never rewrites live maxforge.sync routing or original NDJSON evidence, and forget is not secure physical erasure.",
      inputSchema: z.object({
        action: z.enum(["rekey", "merge", "forget"]),
        expectedProjectId: z.string().describe(
          "Exact project.id shown by maxforge_status or identity inspection"
        ),
        sourcePatcherId: patcherIdSchema.describe(
          "Closed source logical patch identity"
        ),
        scope: scopeSchema.describe(
          "Exact scope shared by source and target"
        ),
        targetPatcherId: patcherIdSchema.optional().describe(
          "Required for rekey and merge; omit for forget"
        ),
        reason: z.string().min(1).max(512).describe(
          "Human-confirmed reason recorded in the append-only decision ledger"
        ),
      }).superRefine((value, context) => {
        if (value.action === "forget" && value.targetPatcherId !== undefined) {
          context.addIssue({
            code: "custom",
            message: "forget must omit targetPatcherId",
            path: ["targetPatcherId"],
          });
        }
        if (value.action !== "forget" && value.targetPatcherId === undefined) {
          context.addIssue({
            code: "custom",
            message: `${value.action} requires targetPatcherId`,
            path: ["targetPatcherId"],
          });
        }
      }),
      outputSchema: patchHistoryIdentityStatusSchema.extend({
        action: z.enum(["rekey", "merge", "forget"]),
        physicalDataErased: z.literal(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({
      action,
      expectedProjectId,
      sourcePatcherId,
      scope,
      targetPatcherId,
      reason,
    }) => {
      try {
        const result = options.service.resolvePatchHistoryIdentity({
          action,
          expectedProjectId,
          source: { patcherId: sourcePatcherId, scope },
          ...(targetPatcherId
            ? { target: { patcherId: targetPatcherId, scope } }
            : {}),
          reason,
        });
        return toolResult({ ...result });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_erase_project_history",
    {
      title: "Erase retained project edit history",
      description:
        "Physically delete maxforge-owned edit-history chunks and the project identity-resolution ledger, then clear retained observations from MCP memory. Every Max WebSocket client must be disconnected. Call this only after the human explicitly requests deletion and supplies the exact confirmation phrase. This does not delete Max patches, DSL/config files, or the desired-state cache, and filesystem/SSD secure overwrite is not guaranteed.",
      inputSchema: z.object({
        expectedProjectId: z.string().describe(
          "Exact project.id shown by maxforge_status"
        ),
        confirmation: z.string().describe(
          "Exact phrase: ERASE PROJECT HISTORY <project.id>"
        ),
      }),
      outputSchema: projectHistoryErasureSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ expectedProjectId, confirmation }) => {
      try {
        return toolResult({
          ...options.service.eraseProjectHistory({
            expectedProjectId,
            confirmation,
          }),
        });
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
        "Accept the exact reviewed live structure as the next managed and agent-intent baseline without replaying the human's structural edits. Requires the structure token returned by maxforge_review_live_changes. Safe managed edits advance the native revision with a zero-operation, token-bound plan; conflicts and unrepresentable protocol-v1 patch-cord metadata are rejected. Returns a retained source reference instead of injecting complete DSL into agent context.",
      inputSchema: z.object({
        patcherId: patcherIdSchema.describe("Registered target Max patch ID"),
        scope: scopeSchema.describe("Exact managed scope of the target patch"),
        expectedStructureToken: structureTokenSchema.describe(
          "Exact structureToken returned by the immediately preceding live-change review"
        ),
      }),
      outputSchema: adoptedChangeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (request) => {
      try {
        const result = await options.service.adoptLiveChanges(request);
        const source = options.service.getWorkingSource(
          request.patcherId,
          request.scope
        );
        return toolResult({
          patcherId: request.patcherId,
          scope: request.scope,
          previousRevision: result.previousRevision,
          adoptedRevision: result.adoptedRevision,
          revisionAdvanced: result.revisionAdvanced,
          ...(result.acknowledgement
            ? { acknowledgement: result.acknowledgement }
            : {}),
          structureToken: result.structureToken,
          managedChangeCount: result.managedChangeCount,
          unmanagedChangeCount: result.unmanagedChangeCount,
          statePersisted: result.statePersisted,
          ...(result.stateWarning ? { stateWarning: result.stateWarning } : {}),
          sourceRef: source.sourceRef,
          sourceCharacters: source.sourceCharacters,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_prepare_change",
    {
      title: "Prepare a compact token-bound Max change",
      description:
        "Compile complete desired DSL once and retain the full native plan behind a one-time receipt. Returns compact operation counts, every delete/disconnect, replacements, warnings, and merge conflicts without returning bulk create/connect/rollback operations. Set manualChanges=merge only after reviewing live edits.",
      inputSchema: prepareChangeRequestSchema,
      outputSchema: preparedChangeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (request) => {
      try {
        if (request.baseSourceRef !== undefined && request.edits !== undefined) {
          return toolResult({
            ...await options.service.prepareSourceEdit({
              patcherId: request.patcherId,
              scope: request.scope,
              baseSourceRef: request.baseSourceRef,
              edits: request.edits,
              manualChanges: request.manualChanges,
              expectedStructureToken: request.expectedStructureToken,
              catalogDigest: options.getCatalog().digest,
            }),
          });
        }
        let currentDsl = request.currentDsl;
        if (request.currentSourceRef !== undefined) {
          currentDsl = options.service.getWorkingSource(
            request.patcherId,
            request.scope,
            request.currentSourceRef
          ).source;
        }
        if (request.desiredDsl === undefined) {
          throw new Error("desiredDsl is required outside source-edit mode");
        }
        return toolResult({
          ...await options.service.prepareChange({
            patcherId: request.patcherId,
            scope: request.scope,
            desiredDsl: request.desiredDsl,
            ...(currentDsl !== undefined ? { currentDsl } : {}),
            manualChanges: request.manualChanges,
            expectedStructureToken: request.expectedStructureToken,
            catalogDigest: options.getCatalog().digest,
          }),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_apply_prepared_change",
    {
      title: "Apply one prepared Max change",
      description:
        "Consume one token-bound receipt returned by maxforge_prepare_change, apply its retained plan without retransmitting or recompiling DSL, and wait for exact revision acknowledgement. The receipt is invalidated by catalog/revision changes and consumed before native mutation. Do not retry a timeout or warning blindly.",
      inputSchema: z.object({ receiptId: receiptIdSchema }),
      outputSchema: z.object({
        receiptId: receiptIdSchema,
        patcherId: patcherIdSchema,
        scope: scopeSchema,
        baseRevision: revisionSchema,
        targetRevision: revisionSchema,
        operationCount: z.number().int().nonnegative(),
        acknowledgement: acknowledgementSchema,
        baselineCaptured: z.boolean(),
        verification: postApplyVerificationSchema.optional(),
        baselineWarning: z.string().optional(),
        manualChangesMerged: z.number().int().nonnegative(),
        statePersisted: z.boolean(),
        stateWarning: z.string().optional(),
        sourceRef: sourceRefSchema,
        sourceCharacters: z.number().int().nonnegative(),
        workingDslRequiredAsCurrent: z.boolean(),
        timings: applyDslTimingsSchema,
        warnings: z.array(warningSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ receiptId }) => {
      try {
        return toolResult({
          ...await options.service.applyPreparedChange({
            receiptId,
            catalogDigest: options.getCatalog().digest,
          }),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "maxforge_get_working_source",
    {
      title: "Read an exact retained working DSL source",
      description:
        "Fetch the complete revision-aligned DSL only when it is actually needed for authoring or recovery. Use sourceRef from apply/adopt results to reject stale reads; ordinary status and apply responses deliberately omit the full source.",
      inputSchema: z.object({
        patcherId: patcherIdSchema,
        scope: scopeSchema,
        sourceRef: sourceRefSchema.optional(),
        detail: z.enum(["metadata", "matches", "full"])
          .optional()
          .default("metadata"),
        queries: z.array(z.string().min(1)).min(1).max(20).optional().describe(
          "Exact DSL names or text fragments to locate when detail=matches"
        ),
        contextLines: z.number().int().min(0).max(5).optional().default(1),
      }),
      outputSchema: z.object({
        patcherId: patcherIdSchema,
        scope: scopeSchema,
        sourceRef: sourceRefSchema,
        sourceCharacters: z.number().int().nonnegative(),
        lineCount: z.number().int().positive(),
        matchCount: z.number().int().nonnegative().optional(),
        snippets: z.array(z.object({
          startLine: z.number().int().positive(),
          endLineExclusive: z.number().int().positive(),
          source: z.string(),
        })).optional(),
        source: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ patcherId, scope, sourceRef, detail, queries, contextLines }) => {
      try {
        const result = options.service.getWorkingSource(
          patcherId,
          scope,
          sourceRef
        );
        const metadata = {
          patcherId: result.patcherId,
          scope: result.scope,
          sourceRef: result.sourceRef,
          sourceCharacters: result.sourceCharacters,
          lineCount: result.lineCount,
        };
        if (detail === "full") return toolResult({ ...result });
        if (detail === "matches") {
          if (!queries) {
            throw new Error("queries are required when detail is matches");
          }
          return toolResult({
            ...metadata,
            ...sourceSnippets(result.source, queries, contextLines),
          });
        }
        return toolResult(metadata);
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

function toolResult(
  value: Record<string, unknown>,
  textValue: Record<string, unknown> = value
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(textValue),
      },
    ],
    structuredContent: value,
  };
}

function responseWithout(
  value: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function sourceSnippets(
  source: string,
  queries: readonly string[],
  contextLines: number
): {
  matchCount: number;
  snippets: Array<{
    startLine: number;
    endLineExclusive: number;
    source: string;
  }>;
} {
  const lines = source.split("\n");
  const matchingLines = lines
    .map((line, index) => queries.some((query) => line.includes(query)) ? index : -1)
    .filter((index) => index >= 0);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of matchingLines) {
    const next = {
      start: Math.max(0, index - contextLines),
      end: Math.min(lines.length, index + contextLines + 1),
    };
    const previous = ranges.at(-1);
    if (previous && next.start <= previous.end) {
      previous.end = Math.max(previous.end, next.end);
    } else {
      ranges.push(next);
    }
  }
  return {
    matchCount: matchingLines.length,
    snippets: ranges.map(({ start, end }) => ({
      startLine: start + 1,
      endLineExclusive: end + 1,
      source: lines.slice(start, end).join("\n"),
    })),
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
