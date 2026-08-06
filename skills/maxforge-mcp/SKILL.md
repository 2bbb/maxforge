---
name: maxforge-mcp
description: Operate live Max/MSP patches through the maxforge MCP tools without screenshots, Max JavaScript, node.script, or raw thispatcher commands. Use when an AI agent must inspect the currently registered Max patch, create an isolated patch window, preview and apply complete maxforge DSL, verify revision acknowledgements, or recover from MCP restart, timeout, controller, registration, baseline, or managed-drift errors. Do not use for offline .maxpat compilation when no live Max connection is required; use the maxforge skill instead.
---

# Maxforge MCP

Control a live Max patch through `maxforge-mcp` and the native `maxforge.sync`
external. Treat the DSL as complete desired state and preserve revision safety.

## Required tools

Require these MCP tools:

- `maxforge_help`
- `maxforge_status`
- `maxforge_catalog`
- `maxforge_list_patches`
- `maxforge_create_patch`
- `maxforge_inspect_patch`
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
   to set `MAXFORGE_CONFIG` and restart the MCP process. Do not substitute
   `--allow-unknown` in a live mutation.
4. Call `maxforge_list_patches`. Copy `patcherId` and `scope` exactly; titles
   and filenames are display metadata, not target identities.
5. If a separate window is required, call `maxforge_create_patch` with a unique
   `patcherId`, scope, and title. Creation requires exactly one controller.
6. Call `maxforge_inspect_patch` for the selected target. Read the snapshot;
   never infer patch state from the screen.
7. Build the complete desired DSL. Omitted managed objects and cords are
   deletions, so do not submit a fragment as though it were an imperative edit.
   Use real Max object names only. Signal subpatch ports are `inlet signal` and
   `outlet signal`, never `inlet~` or `outlet~`. Do not infer names by analogy.
8. Call `maxforge_compile_plan` with the target and complete `desiredDsl`.
   Review warnings and every `delete`, `disconnect`, and replacement operation.
   If inspection reports managed edits, call `maxforge_reconcile_patch`
   instead and require `canApply: true`. Read every structured conflict when it
   is false; never convert a conflict into an overwrite.
9. State the target, operation count, destructive operations, and stop
   condition before mutation.
10. Call `maxforge_apply_dsl` with the same target and complete desired DSL.
   Set `manualChanges: "merge"` only when reconciliation of that exact target
   and DSL returned `canApply: true`. Otherwise omit it so drift is rejected.
   Apply repeats inspection and binds its structure token; if the human edits
   the patch before native mutation, treat the resulting rejection as fresh
   drift and inspect again.
11. Count success only when `acknowledgement.revision` equals `targetRevision`.
    `baselineCaptured: false` is a warning after a successful apply, not an
    apply failure.
12. Call `maxforge_inspect_patch` again. Confirm expected box/cord counts and
    that no unexplained managed change remains.
13. After a merged apply, update the working complete DSL to include the
    preserved human edits. Until it is aligned, continue through reconciliation;
    ordinary compile/apply is intentionally rejected to prevent a silent revert.

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

### MCP process restarted

Call `maxforge_status` and verify the persistence path, restored revision, and
pending scopes. Normal restarts restore state automatically. If persistence was
disabled or its file is unavailable, provide the exact previous complete DSL as
`currentDsl` once. Never guess it, reset the revision, or claim the scope is
empty. A pending scope must reconnect so Maxforge can compare its recorded base
and target revisions.

### Managed manual edit detected

Inspection alone does not accept or reset a baseline. Call
`maxforge_reconcile_patch` with the next complete desired DSL. It performs a
three-way merge of the previous agent intent, current Max graph, and next
desired graph while retaining the acknowledged graph for native revision safety.
When `canApply` is true, apply the same DSL with `manualChanges: "merge"`.
Resolve same-field, change-vs-delete, new-managed-identity, and unmanaged-cord
conflicts explicitly. Do not force a winner or fall back to ordinary apply.

After success, inspect and fold preserved text, position, deletion, and
connection edits into the working complete DSL. This is required for clean
restart recovery because the pre-merge agent DSL no longer hashes to Max's
acknowledged merged revision.

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

## Safety boundaries

- Operate only on targets returned by `maxforge_list_patches`.
- Manage only exact `maxforge_<scope>_obj_...` scripting names.
- Preview nontrivial changes before apply.
- Reconcile managed human edits before preserving them; merge mode is opt-in.
- Never remove or fabricate `baseStructureToken`; it prevents stale inspected
  state from being mutated after a concurrent human edit.
- Keep the default unauthenticated WebSocket bridge on loopback. For trusted-LAN
  use, require matching `MAXFORGE_WS_TOKEN` and `maxforge.sync @token`; never
  treat the plaintext token mode as safe for direct Internet exposure.
- Never treat a timeout, process exit, or missing acknowledgement as success.
- `maxforge_catalog` is compiler metadata, not a runtime probe. It does not
  prove the external binary or abstraction search path exists on the Max host.
- Do not save, close, or discard a Max window unless the user asks.
