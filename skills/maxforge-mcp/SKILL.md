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
- `maxforge_list_patches`
- `maxforge_create_patch`
- `maxforge_inspect_patch`
- `maxforge_compile_plan`
- `maxforge_apply_dsl`

If they are unavailable, stop. Explain that the MCP client must launch
`maxforge-mcp` and Max must load a patch containing `maxforge.sync`. Do not
imitate this workflow with screenshots, accessibility automation, Max
JavaScript, `node.script`, or invented `thispatcher` messages.

## Live mutation workflow

1. Call `maxforge_help` with `topic: "workflow"` before the first mutation.
2. Call `maxforge_status` when registration or process state is uncertain.
3. Call `maxforge_list_patches`. Copy `patcherId` and `scope` exactly; titles
   and filenames are display metadata, not target identities.
4. If a separate window is required, call `maxforge_create_patch` with a unique
   `patcherId`, scope, and title. Creation requires exactly one controller.
5. Call `maxforge_inspect_patch` for the selected target. Read the snapshot;
   never infer patch state from the screen.
6. Build the complete desired DSL. Omitted managed objects and cords are
   deletions, so do not submit a fragment as though it were an imperative edit.
   Use real Max object names only. Signal subpatch ports are `inlet signal` and
   `outlet signal`, never `inlet~` or `outlet~`. Do not infer names by analogy.
7. Call `maxforge_compile_plan` with the target and complete `desiredDsl`.
   Review warnings and every `delete`, `disconnect`, and replacement operation.
8. State the target, operation count, destructive operations, and stop
   condition before mutation.
9. Call `maxforge_apply_dsl` with the same target and complete desired DSL.
10. Count success only when `acknowledgement.revision` equals `targetRevision`.
    `baselineCaptured: false` is a warning after a successful apply, not an
    apply failure.
11. Call `maxforge_inspect_patch` again. Confirm expected box/cord counts and
    that no unexplained managed change remains.

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

If Max advertises a non-null revision but the MCP process has no graph state,
provide the exact previous complete DSL as `currentDsl` once. Never guess it,
derive it loosely from a screenshot, reset the revision, or claim the scope is
empty. If the exact DSL is unavailable, stop and report the blocker.

### Managed manual edit detected

Inspection does not accept or reset a baseline. There is no MCP operation that
adopts a managed manual edit. Report the exact managed changes and require them
to be manually restored to the last post-apply structure before another apply.
Unmanaged standalone edits may remain, but a cord touching a managed box is a
managed change.

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
- Never expose the unauthenticated WebSocket bridge outside loopback.
- Never treat a timeout, process exit, or missing acknowledgement as success.
- Do not save, close, or discard a Max window unless the user asks.
