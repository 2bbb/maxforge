---
name: maxforge-mcp
description: Operate and collaboratively edit live Max/MSP patches through the maxforge MCP tools without screenshots, Max JavaScript, node.script, or raw thispatcher commands. Use for maxforge-related live inspection, human-edit adoption, isolated patch creation, desired-DSL preview/apply, acknowledgement verification, or broker/controller/recovery failures. On the first maxforge-related task in a session, check the latest coherent release and local version set with the bundled preflight; do not trigger merely for unrelated general Max/MSP questions. Use the maxforge skill for offline compilation.
---

# Maxforge MCP

Control a live Max patch through `maxforge-mcp` and the native `maxforge.sync`
external. Treat the DSL as complete desired state and preserve revision safety.

## Mandatory version preflight

On the first maxforge-related task in an Agent session, refresh the tracked
skills before checking runtime versions:

```bash
node <skill-directory>/scripts/refresh-skills.mjs --json
node <skill-directory>/scripts/check-version.mjs --json
```

If refresh reports `reloadRequired: true`, read the newly installed skill and
this preflight again before continuing. The Skills CLI has no check-only mode,
so changed tracked skills are updated. A failed upstream check remains
`unknown`; never cache or report it as current. Do not repeat the preflight in
the same session unless the user asks, configuration/package state changes, or
an update is being prepared. Successful skill checks and remote GitHub/npm data
are cached for 24 hours, while local configuration and package metadata are read
on every run. Do not run it for an unrelated Max/MSP question.

- `update-available`: report the exact coherent version once. A check does not
  authorize replacement. Do not silently
  replace a working exact set; continue unless the user requested an update or
  the task requires the newer release.
- `blocked`: published-version or release-asset incoherence blocks upgrading.
  `LOCAL_VERSION_MISMATCH` or `MCP_MOVING_VERSION` blocks live mutation.
- `unknown` or `stale`: continue offline diagnosis without claiming a latest
  version.

After the stdio server is available, `maxforge_status` and
`maxforge_list_patches` remain authoritative for the running broker and loaded
external. A local file scan cannot establish what Max actually loaded.

When the user requests an update, read and follow
[`references/update-workflow.md`](references/update-workflow.md). The required
order is refreshed skill instructions, one coherent release target, MCP pin,
detached broker, complete Max package, conditional restart prompts, then live
version verification. Never omit the broker merely because the config changed.

## Tool availability and setup

For Codex, a typical stdio entry is:

```toml
[mcp_servers.maxforge]
command = "npx"
args = ["-y", "--package=maxforge@X.Y.Z", "maxforge-mcp"]
```

This starts only the Node.js side. Max must separately load the matching native
`maxforge.sync` external in a controller patch. Replace `X.Y.Z` with one intended
release; never copy a version number from this skill. Do not keep live MCP
configuration on npm's moving `latest` dist-tag. The skill may align a mismatched
native package from the exact versioned GitHub Release, or perform an explicitly
requested coherent-set update. Merely discovering a newer release does not
authorize configuration or package mutation.
The automated exact-asset alignment contract starts with `v0.5.0`. Releases
through `v0.4.4` use the legacy unversioned Max-package asset and cannot be
repaired by this installer. Do not fall back silently: upgrade the npm runtime,
broker, and native package together to one release with versioned assets, or
report that legacy installation remains a manual migration.

The detached broker can outlive the frontend that started it. During an update,
inspect and restart it with the package version being installed:

```bash
npx -y --package=maxforge@X.Y.Z maxforge broker status \
  --config /absolute/path/maxforge.config.json
npx -y --package=maxforge@X.Y.Z maxforge broker restart \
  --config /absolute/path/maxforge.config.json
```

Replace `X.Y.Z` with the intended installed version; it is not a literal package
specifier to copy unchanged.

`restart` refuses connected MCP/Max clients and pending native operations. Close
clients for a non-disruptive update. Use `--force` only after the human accepts
disconnection; it still cannot interrupt a pending operation. After replacement,
reconnect this MCP server entry to negotiate the full tool inventory. Do not
restart the outer Agent host merely to replace the broker.

Require `maxforge_help` and `maxforge_status` for diagnosis. A normal mutation
session must expose all of these tools:

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
- `maxforge_prepare_change`
- `maxforge_apply_prepared_change`
- `maxforge_get_working_source`

If only `maxforge_help` and `maxforge_status` are available, inspect status
before giving setup advice. `VERSION_MISMATCH` and `RECONNECT_REQUIRED` are
intentional diagnostic-only states, not evidence that the command is missing.
If status is unavailable, stop and verify the stdio entry above. If the full
inventory is available but no patch is registered, Max must load a controller
patch containing `maxforge.sync`. Do not imitate this workflow with screenshots,
accessibility automation, Max JavaScript, `node.script`, or invented
`thispatcher` messages.

## Live mutation workflow

1. Confirm the compact tool trio `maxforge_prepare_change`,
   `maxforge_apply_prepared_change`, and `maxforge_get_working_source` exists.
   Call `maxforge_help` only when this contract is unavailable or unfamiliar;
   a skill-guided normal edit does not need a redundant help round trip.
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
   not, stop mutation and follow
   [`references/native-version-alignment.md`](references/native-version-alignment.md).
   Align the complete Max package from the exact `vX.Y.Z` release, back up the
   replaced package outside Max search paths, remove confirmed stale copies,
   restart Max, reopen the patch, and list it again. A patch `filepath` and a
   nearby external do not prove which binary Max resolved. Never fall back to a
   moving latest release or overwrite multiple candidate copies by guesswork.
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
8. Preserve complete desired-state semantics while minimizing source transfer:
   - For a new target or broad rewrite, send complete `desiredDsl` once to
     `maxforge_prepare_change`.
   - For a local edit, retain the latest `sourceRef`. Call
     `maxforge_get_working_source` with default `metadata`, or `detail: "matches"`
     plus semantic names/text to fetch only bounded snippets. Use
     `detail: "full"` only for a broad rewrite or recovery.
   - Submit local edits as `baseSourceRef` plus `edits`. Ranges are 1-based,
     half-open `[startLine, endLine)`, and `startLine == endLine` inserts. Every
     range refers to the original retained source and ranges must not overlap.
     The broker reconstructs and compiles the complete next DSL; this is a
     compact transport, not imperative patch syntax. A stale ref fails closed.
    Omitted managed objects and cords are deletions. Use real Max object names;
    signal subpatch ports are `inlet signal` and `outlet signal`, never invented
    `inlet~`/`outlet~` names. Give every object a contextual semantic DSL name,
    which becomes its managed varname suffix. When the user did not provide a
    name, inspect the surrounding patch context before naming it: use topology,
    object text, comments, and established vocabulary. Never use `obj1`,
    `thing`, `new_object`, or `temp` merely because the user omitted a name.
9. If inspection reports live changes, call `maxforge_review_live_changes`.
   The default summary deliberately omits the full snapshot, raw change rows,
   duplicate signal rows, and proposed full DSL. Request `detail: "full"` only
   when exact before/after values are needed. Treat edit clusters and risks as
   evidence, not certainty about intent; ask only when competing interpretations
   imply different actions.
10. Choose one drift path. Adopt an accepted current managed graph with
    `maxforge_adopt_live_changes` and the exact reviewed structure token, then
    retain its returned `sourceRef`. If a concrete next desired state already
    exists, prepare it with `manualChanges: "merge"` and require
    `canApply: true`. Do not claim unmanaged additions or force conflicts.
11. Call `maxforge_prepare_change` in exactly one source mode: complete
    `desiredDsl`, or `baseSourceRef` plus `edits`. Pass the latest
    `expectedStructureToken` when available; omission performs a fresh inspect.
    If a previous result says `workingDslRequiredAsCurrent`, pass its exact
    `sourceRef` as `currentSourceRef` for inline DSL, or use it as
    `baseSourceRef` for line edits. Review operation counts, every destructive
    operation, replacements, warnings, and conflicts. A receipt exists only
    when `canApply` is true. The full create/connect/rollback plan stays in the
    broker instead of entering agent context.
12. State the target, operation count, destructive operations, and stop
    condition before mutation.
13. Call `maxforge_apply_prepared_change` with only `receiptId`. A receipt is
    bound to catalog digest, target revisions, and inspected native structure;
    it is one-time, process-local, bounded, and consumed before native mutation.
    Never retry it after timeout, rejection, or warning. Inspect current state
    and prepare a new receipt instead. Concurrent human edits fail at the native
    structure-token check before mutation.
14. Count success only when `acknowledgement.revision` equals `targetRevision`.
    `baselineCaptured: false` is a warning after a successful apply, not an
    apply failure.
15. When `verification` is present, require its revision to equal
    `targetRevision` and check its box/cord counts. Inspect again when
    verification is absent, baseline capture failed, or complete post-apply
    topology is needed. If the workflow is slow, compare the returned `timings`
    stages rather than guessing which component is responsible.
16. After every apply or adoption, retain `sourceRef` and `sourceCharacters`,
    not full source text. Ordinary no-merge apply preserves authored `for`/`if`
    source in broker state. Adoption and merge may retain explicit graph-derived
    DSL because direct Max edits cannot be mapped safely back into macros. Fetch
    only the regions needed for the next edit. Prepared receipts do not survive
    broker restart; retained working source does when state persistence succeeds.
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

DSL names are durable managed identities. For example, `filter_cutoff` in scope
`synth` becomes managed varname `maxforge_synth_obj_filter_cutoff`; renaming it
causes an identity replacement rather than a cosmetic label change. If a human
creates or edits an object without assigning a managed varname, inspect its
object text, comments, neighbors, routing, and the surrounding naming scheme
before proposing a semantic name. Do not silently claim an unmanaged human-created box.
Only incorporate it after the user's intent to manage it is established, then
use the context-derived DSL name consistently in the complete desired state.

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

If a frontend initialized in diagnostic mode because of `VERSION_MISMATCH`,
repeat `maxforge_status` after replacing the broker. Diagnostic status is live,
not a cached startup snapshot. `RECONNECT_REQUIRED` means the new broker is
compatible; reconnect only that MCP server entry to negotiate the full tool
set. Do not restart the outer Agent host.

If Max reports a third revision, stop ordinary prepare/review calls.
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
`maxforge_review_live_changes`. Its summary describes structural evidence and
must not be presented as a certain explanation of human intent. Request
`detail: "full"` only when exact raw changes referenced by cluster
`changeIndexes` are necessary; the default avoids loading the complete snapshot,
duplicate signals, raw rows, and proposed DSL into agent context.

If the reviewed managed graph is the state that should survive, adopt it using
the exact returned structure token. Adoption re-inspects, rejects stale review,
reconstructs the managed graph, and advances native revision with zero
structural operations because the edit is already live. Retain the returned
`sourceRef`; do not recreate source from summaries.
Managed patch-cord metadata is not represented by protocol v1 and therefore
blocks adoption rather than being silently discarded.

If the agent already has a next desired state, call `maxforge_prepare_change`
with `manualChanges: "merge"`. Preparation performs the three-way merge of the
previous agent intent, current Max graph, and next desired graph while retaining
the acknowledged graph for native revision safety.
An added reserved managed identity can be recovered only when complete desired
DSL explicitly defines the exact live box and all managed cords involving it.
Expect a zero-operation revision acknowledgement when the structure is already
live. Duplicate identity, field/layout/configuration mismatch, cord mismatch,
unmanaged cord, and unrepresentable graph cases remain fail-closed conflicts.
When `canApply` is true, apply only the returned receipt.
Resolve same-field, change-vs-delete, new-managed-identity, and unmanaged-cord
conflicts explicitly. Do not force a winner or fall back to ordinary apply.

After success, retain the returned `sourceRef`. This identifies the merged
working source because the pre-merge DSL may no longer hash to Max's acknowledged
revision. When `workingDslRequiredAsCurrent` is true, use `currentSourceRef` for
inline preparation or `baseSourceRef` for source edits until a successful apply
clears the flag.

Unmanaged standalone edits remain outside the managed graph. A cord touching a
managed box is preserved only while that box is not deleted or structurally
recreated; reconciliation reports the destructive case as a conflict.
Reparenting a managed box into another patcher path is a delete/add operation,
not a mergeable move. Resolve it explicitly in the complete DSL.

### Timeout or transport error

Do not retry blindly. Protocol v1 is not transactional and an ambiguous failure
may leave partial mutation. Call `maxforge_status`, then inspect the live target
before deciding whether a newly prepared desired-state receipt is safe. The old
receipt was consumed before native mutation and must not be retried.

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
issue creation is available, open an issue at `bbb-max-externals/maxforge`. Include
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
  baseline or prepare a concrete next state with merge enabled; both paths are
  opt-in.
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
