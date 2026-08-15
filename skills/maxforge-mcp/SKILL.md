---
name: maxforge-mcp
description: Operate and collaboratively edit live Max/MSP patches through the maxforge MCP tools without screenshots, Max JavaScript, node.script, or raw thispatcher commands. Use when an AI agent must inspect the currently registered Max patch, interpret and adopt human edits, create an isolated patch window, preview and apply complete maxforge DSL, verify revision acknowledgements, or recover from broker restart, timeout, controller, registration, baseline, or managed-drift errors. Do not use for offline .maxpat compilation when no live Max connection is required; use the maxforge skill instead.
---

# Maxforge MCP

Control a live Max patch through `maxforge-mcp` and the native `maxforge.sync`
external. Treat the DSL as complete desired state and preserve revision safety.

## Required tools

Require these MCP tools:

- `maxforge_help`
- `maxforge_status`
- `maxforge_catalog`
- `maxforge_reload_catalog`
- `maxforge_list_patches`
- `maxforge_create_patch`
- `maxforge_open_patch`
- `maxforge_save_patch`
- `maxforge_close_patch`
- `maxforge_inspect_patch`
- `maxforge_inspect_pending_apply`
- `maxforge_recover_pending_apply`
- `maxforge_get_live_edit_history`
- `maxforge_get_patch_history_identity`
- `maxforge_resolve_patch_history_identity`
- `maxforge_erase_project_history`
- `maxforge_review_live_changes`
- `maxforge_adopt_live_changes`
- `maxforge_reconcile_patch`
- `maxforge_compile_plan`
- `maxforge_apply_dsl`

If they are unavailable, stop. Explain that the MCP client must launch
`maxforge-mcp` and Max must load a patch containing `maxforge.sync`. Do not
imitate this workflow with screenshots, accessibility automation, Max
JavaScript, `node.script`, or invented `thispatcher` messages.

## Live mutation workflow

1. Call `maxforge_help` with `topic: "workflow"` before the first mutation.
2. Call `maxforge_status` when registration or process state is uncertain.
3. Before using a custom external or abstraction, call `maxforge_catalog` and
   require its configured definition. If it is absent, stop and tell the user
   to set `MAXFORGE_CONFIG`. If configured files changed after startup, call
   `maxforge_reload_catalog` and verify the new digest. A rejected reload leaves
   the old catalog active. Do not substitute `--allow-unknown` in a live mutation.
   Confirm `catalog.project.id` when edit history must survive broker restart;
   without it, persistent edit evidence is deliberately disabled.
4. Call `maxforge_list_patches`. Copy `patcherId` and `scope` exactly; titles
   and filenames are display metadata, not target identities. Before any
   mutation, require the target's `versionCompatible` to be `true`. Its
   `externalVersion` is embedded in the binary Max actually loaded and must
   exactly match `maxforge_status.bridge.expectedExternalVersion`. If it does
   not, stop: install the matching external in an installed Max package or an
   explicitly configured project search path, remove stale same-named copies,
   restart Max, reopen the patch, and list it again. A patch `filepath` and a
   nearby external do not prove which binary Max resolved.
5. If a separate window is required, call `maxforge_create_patch` with a unique
   `patcherId`, scope, and title. To manage an existing `.maxpat`, use
   `maxforge_open_patch` with an absolute path on the Max host. Opening injects
   one bridge object and refuses files that already contain `maxforge.sync`.
   Both operations require exactly one controller.
6. Call `maxforge_inspect_patch` for the selected target with summary detail.
   Read its revision, structure token, counts, and changes. Request full detail
   only when complete surrounding topology is needed; never infer state from the
   screen.
7. If the order of recent edits could change the interpretation, call
   `maxforge_get_live_edit_history`. Check `supported`, `droppedEvents`, and
   `comparisonBasis`; treat `latestSequence` only as an `afterSequence` polling
   cursor. Inspect `persistence`, `sessionId`, `instanceId`, and
   `sessionSequence`. The 75 ms observations are structural evidence, not undo
   actions, gestures, selection, causality, or proof of human intent. History
   is bounded; project-scoped NDJSON may survive bridge restart, while reconnect
   starts a new session baseline. `observedAt` is snapshot-arrival time. Treat
   `patchMetadata.filepath` as a locator only, never as target identity.
   If path warnings are ambiguous, call `maxforge_get_patch_history_identity`
   for each candidate. Do not resolve them from path similarity. Only after the
   human confirms the relationship and the source patch is closed may you call
   `maxforge_resolve_patch_history_identity`: `rekey` requires an unused target,
   `merge` requires a known target, and `forget` only hides Agent-facing history.
   These operations neither rewrite live `maxforge.sync` routing nor physically
   erase append-only evidence.
   If the human explicitly requests physical history deletion, close every Max
   client, verify `maxforge_status.bridge.connectedClients` is zero, and call
   `maxforge_erase_project_history` with the exact project ID and confirmation
   phrase. Never present it as secure overwrite: it excludes Max/DSL/config
   files and desired-state cache, and SSD/filesystem remnants are not guaranteed.
   Persistent history allows one project broker writer per directory. Multiple
   `maxforge-mcp` stdio frontends attach to that broker. If startup reports
   `writer-v1.lock`, do not bypass it: dead valid leases recover automatically,
   while a live or malformed lease requires diagnosis rather than deletion.
8. Build the complete desired DSL. Omitted managed objects and cords are
   deletions, so do not submit a fragment as though it were an imperative edit.
   Use real Max object names only. Signal subpatch ports are `inlet signal` and
   `outlet signal`, never `inlet~` or `outlet~`. Do not infer names by analogy.
9. If inspection reports live changes, call `maxforge_review_live_changes`.
   Treat its layout, configuration, annotation, ownership, and routing signals
   as evidence, not as certainty about the human's intent. Read related changes
   together through `review.editClusters`, follow each cluster's `changeIndexes`
   to the raw before/after values, and use `interpretationRisks` as ambiguity
   prompts. `clarificationRecommendedFor` is not a command to ask automatically:
   ask the human only when competing interpretations would produce different
   next actions.
10. Choose one drift path. If the accepted current managed graph should become
   the baseline, call `maxforge_adopt_live_changes` with the exact reviewed
   structure token. If a concrete next desired DSL is already ready, call
   `maxforge_reconcile_patch` and require `canApply: true`. Do not silently
   claim unmanaged additions, and never convert a conflict into an overwrite.
11. After adoption, immediately replace the working complete source with the
    returned `workingDsl`; it is round-trip checked and uses four-value `at()`
    when resize must survive. It is explicit managed state, so do not claim it
    preserves `for`/`if` authoring structure or patch-level metadata. Otherwise
    call `maxforge_compile_plan` with the
    target and complete `desiredDsl`. Review warnings and every `delete`,
    `disconnect`, and replacement operation.
12. State the target, operation count, destructive operations, and stop
   condition before mutation.
13. Call `maxforge_apply_dsl` with the same target and complete desired DSL.
   Pass the exact `structureToken` from the latest inspection or reconciliation
   as `expectedStructureToken` so the service can reuse that observation.
   Set `manualChanges: "merge"` only when reconciliation of that exact target
   and DSL returned `canApply: true`. Otherwise omit it so drift is rejected.
   Apply reuses that exact cached inspection and binds its structure token;
   Max still recomputes the token immediately before mutation. If the human
   edits the patch before native mutation, treat the resulting rejection as
   fresh drift and inspect again.
14. Count success only when `acknowledgement.revision` equals `targetRevision`.
    `baselineCaptured: false` is a warning after a successful apply, not an
    apply failure.
15. When `verification` is present, require its revision to equal
    `targetRevision` and check its box/cord counts. Inspect again when
    verification is absent, baseline capture failed, or complete post-apply
    topology is needed. If the workflow is slow, compare the returned `timings`
    stages rather than guessing which component is responsible.
16. After every apply, retain returned `workingDsl` as the next complete source.
    Ordinary no-merge apply preserves the submitted authored DSL and its
    `for`/`if` structure. Adoption and merge may return explicit graph-derived
    DSL because direct Max edits cannot be mapped safely back into source macros.
    This is mandatory after a merge because it includes preserved human edits
    that may not exist in submitted `desiredDsl`. If
    `workingDslRequiredAsCurrent` is true, pass the exact returned source as
    `currentDsl` in every preview and apply until a successful apply clears the
    flag. A read-only preview does not persist this alignment.
17. Apply does not persist the Max document. Call `maxforge_save_patch` only
    when persistence is intended. Omit `path` only for an already-saved patch;
    save-as requires an absolute Max-host path and explicit `overwrite: true`
    to replace a file.
18. Use `maxforge_close_patch` only when closure is intended. Dirty state is
    rejected unless `discard: true` is explicit; save first otherwise.

## Desired DSL rule

Use DSL as full scope ownership, not command syntax:

```maxdsl
patch "Generated controls"

for i in 0..7 {
  button_${i} = button at(${40 + i * 90}, 80)
  value_${i} = number at(${40 + i * 90}, 130)
  button_${i} -> value_${i}
}
```

When changing this graph, retain every managed object and connection that
should survive. Do not send only the new line.

## Recovery rules

Call `maxforge_help` with `topic: "recovery"` before responding to an ambiguous
failure.

### Broker restarted

Restarting one stdio frontend does not restart shared broker state. After an
actual broker restart, call `maxforge_status` and verify the persistence path,
restored revision, and pending scopes. Normal broker restarts restore state
automatically. A missing default v2 state is migrated from the matching v1 file
only when every graph has a lossless DSL representation; migration failure is a
startup error, not permission to treat the patch as unmanaged. Explicit custom
state paths are not searched for guessed legacy siblings. If persistence was
disabled or its file is unavailable, provide the exact previous complete DSL as
`currentDsl` once. Never guess it, reset the revision, or claim the scope is
empty. A pending scope must reconnect so Maxforge can compare its recorded base
and target revisions.

If Max reports a third revision, stop ordinary compile/review/reconcile calls.
Call `maxforge_inspect_pending_apply` and preserve its base, target, intent, and
live DSL evidence. If it returns `supersededApply`, preserve that original
unresolved target/intent evidence as well; the active target is a durable
recovery transition and ordinary tools must remain blocked. Call
`maxforge_recover_pending_apply` with `rebase_live` only
when trusted complete `currentDsl` compiles to the exact returned live revision,
and pass the unchanged structure token. A stale token, guessed DSL, state-file
deletion, or fabricated empty graph is not recovery.

### Managed manual edit detected

Inspection alone does not accept or reset a baseline. First call
`maxforge_review_live_changes`. Its signals describe structural evidence and
must not be presented as a certain explanation of the human's intent.
Interpret `review.editClusters` rather than isolated signal rows. A cluster
correlates changes by patcher path and shared object identity, while independent
edits remain separate. Inspect the raw changes referenced by `changeIndexes`;
the cluster summary is not a substitute for before/after values.

If the reviewed managed graph is the state that should survive, adopt it using
the exact returned structure token. Adoption re-inspects, rejects stale review,
reconstructs the managed graph, and advances native revision with zero
structural operations because the edit is already live. Replace the working
complete source with returned `workingDsl`; do not recreate it from summaries.
Managed patch-cord metadata is not represented by protocol v1 and therefore
blocks adoption rather than being silently discarded.

If the agent already has a next desired DSL, call `maxforge_reconcile_patch`
instead. It performs a three-way merge of the previous agent intent, current
Max graph, and next desired graph while retaining the acknowledged graph for
native revision safety.
An added reserved managed identity can be recovered only when complete desired
DSL explicitly defines the exact live box and all managed cords involving it.
Expect a zero-operation revision acknowledgement when the structure is already
live. Duplicate identity, field/layout/configuration mismatch, cord mismatch,
unmanaged cord, and unrepresentable graph cases remain fail-closed conflicts.
When `canApply` is true, apply the same DSL with `manualChanges: "merge"`.
Resolve same-field, change-vs-delete, new-managed-identity, and unmanaged-cord
conflicts explicitly. Do not force a winner or fall back to ordinary apply.

After success, inspect and replace the working complete source with returned
`workingDsl`. This is required because the pre-merge agent DSL no longer hashes
to Max's acknowledged merged revision. When `workingDslRequiredAsCurrent` is
true, keep passing it as `currentDsl` to both preview and apply until a
successful apply clears the flag.

Unmanaged standalone edits remain outside the managed graph. A cord touching a
managed box is preserved only while that box is not deleted or structurally
recreated; reconciliation reports the destructive case as a conflict.
Reparenting a managed box into another patcher path is a delete/add operation,
not a mergeable move. Resolve it explicitly in the complete DSL.

### Timeout or transport error

Do not retry blindly. Protocol v1 is not transactional and an ambiguous failure
may leave partial mutation. Call `maxforge_status`, then inspect the live target
before deciding whether a new desired-state apply is safe.

### Baseline warning

If apply returns `baselineCaptured: false`, the acknowledged mutation already
succeeded. Do not repeat it merely to capture a baseline. Inspect explicitly;
change comparison remains unavailable until a later successful baseline.

### No registered patch

Use `maxforge_status` to distinguish no WebSocket client from an unregistered
client. Ask the user to open the controller patch or verify the native external;
do not guess a target.

## Report reproducible defects

When tool evidence shows a maxforge defect rather than stale input, missing
catalog configuration, an expected fail-closed rejection, or a Max limitation,
search existing issues first. If no duplicate exists and authenticated GitHub
issue creation is available, open an issue at `2bbb/maxforge`. Include
maxforge/broker/Node/OS/Max versions, MCP transport and client, exact tool
sequence, minimal DSL and patch state, actual and expected behavior, and bounded
responses/logs with tokens and private paths removed. Link the created issue in
the response. Do not file ambiguous timeout speculation before status and live
inspection establish the failure. If write access is unavailable, return a
ready-to-file issue body and the repository issue URL instead of claiming it
was created.

## Safety boundaries

- Operate only on targets returned by `maxforge_list_patches`.
- Mutate only targets with `versionCompatible: true`; status/list/inspection
  are diagnostic when the external version is unknown or mismatched.
- Manage only exact `maxforge_<scope>_obj_...` scripting names.
- Preview nontrivial changes before apply.
- Review managed human edits before interpreting them. Adopt an accepted live
  baseline or reconcile it with a concrete next DSL; both paths are opt-in.
- Never remove or fabricate `baseStructureToken`; it prevents stale inspected
  state from being mutated after a concurrent human edit.
- Keep the default unauthenticated WebSocket bridge on loopback. For trusted-LAN
  use, require matching `MAXFORGE_WS_TOKEN` and `maxforge.sync @token`; never
  treat the plaintext token mode as safe for direct Internet exposure.
- Never treat a timeout, process exit, or missing acknowledgement as success.
- `maxforge_catalog` is compiler metadata, not a runtime probe. It does not
  prove the external binary or abstraction search path exists on the Max host.
- Do not save, close, or discard a Max window unless the user asks. Never turn
  a save/close rejection into `overwrite: true` or `discard: true` implicitly.
