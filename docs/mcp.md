# maxforge MCP control

`maxforge-mcp` lets an MCP-capable agent replace a scope-owned Max patch graph
from complete desired DSL. It does not run an agent or JavaScript inside Max.

## Architecture

```text
MCP client
  | stdio
maxforge-mcp (Node.js 20+)
  | ws://127.0.0.1:8766 by default
  | authenticated LAN WebSocket when explicitly enabled
one maxforge.sync per registered patch (native Max external)
  | Max SDK
containing patcher
```

The boundary is intentional:

- MCP, DSL compilation, diffing, and session state belong in Node.js.
- WebSocket transport, request routing, patcher ownership validation, and Max SDK
  mutation belong in `maxforge.sync`.
- The WebSocket implementation is not duplicated. `maxforge.sync` compiles the
  reusable, Max-independent client source pinned by the `bbb.agent` submodule.

This makes the runtime boundary match the visible patch boundary: each patch
needs one object, not a transport object, routers, prepends, startup messages,
and patch cords. WebSocket callbacks enqueue events for Max's main thread;
network threads never call the Max API directly.

## Start

The server uses MCP stdio. Do not write arbitrary output to stdout; stdout is
the protocol channel.

```bash
npm run build
node dist/mcp/server.js
```

Published-package MCP configuration:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": [
        "-y",
        "--package=maxforge@latest",
        "maxforge-mcp"
      ]
    }
  }
}
```

The npm package installs the `maxforge-mcp` Node.js executable. It does not
install the native `maxforge.sync` external into Max. A working live setup needs
both processes and at least one open, registered Max patch.

Environment variables:

| Name | Default | Meaning |
|---|---:|---|
| `MAXFORGE_WS_TOKEN` | unset | Shared LAN token; setting it enables authenticated LAN publication |
| `MAXFORGE_WS_HOST` | conditional | `127.0.0.1` without a token, `0.0.0.0` with a token |
| `MAXFORGE_WS_PORT` | `8766` | WebSocket port used by `maxforge.sync` |
| `MAXFORGE_APPLY_TIMEOUT_MS` | `5000` | Max apply, inspection, or patch creation response timeout |
| `MAXFORGE_CONFIG` | unset | Explicit project object catalog; no MCP working-directory discovery |
| `MAXFORGE_STATE_FILE` | `~/.maxforge/mcp-state-<port>-v1.json` | Atomic graph/baseline state file; set to `off` only to disable restart recovery |

When custom externals or reusable abstractions appear in desired DSL, set
`MAXFORGE_CONFIG` in the MCP client process configuration. Prefer an absolute
path because a client's launch directory is not a reliable project root:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": ["-y", "--package=maxforge@latest", "maxforge-mcp"],
      "env": {
        "MAXFORGE_CONFIG": "/projects/show/maxforge.config.json"
      }
    }
  }
}
```

The catalog is loaded once at server startup. Restart the MCP process after
editing it. A valid declaration is not a runtime availability check: the Max
machine still needs the corresponding external binary or abstraction search
path. See [`object-catalog.md`](object-catalog.md#project-object-catalogs).

With no token, non-loopback bind addresses are rejected and existing local
setups remain unauthenticated on `127.0.0.1`. Set a human-chosen token to bind
to all interfaces:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": ["-y", "--package=maxforge@latest", "maxforge-mcp"],
      "env": { "MAXFORGE_WS_TOKEN": "studio-session_1" }
    }
  }
}
```

On the Max machine, point `maxforge.sync` at the LAN address of the machine
running the MCP process and use the same token:

```text
maxforge.sync @host 192.168.1.20 @port 8766 @token studio-session_1
```

Tokens contain 1–256 URL-safe characters: letters, digits, `.`, `_`, `~`, and
`-`. `MAXFORGE_WS_HOST` may override the authenticated bind address when
binding every interface is undesirable. The WebSocket remains plaintext: LAN
mode is suitable for a trusted local network, not direct Internet exposure.

## AI agent guidance

The MCP server advertises an agent workflow in its server instructions. Every
tool also publishes a structured input and output schema; agents should not
guess field names from prose or parse human-readable text when
`structuredContent` is available.

Start an unfamiliar session by calling `maxforge_help` with:

```json
{ "topic": "workflow" }
```

Available topics are:

| Topic | Use it when |
|---|---|
| `workflow` | selecting, previewing, applying, and verifying a live target |
| `setup` | the server runs but Max does not register a usable patch |
| `recovery` | restart, timeout, baseline warning, or managed manual drift occurred |
| `safety` | checking identity, ownership, transport, and mutation boundaries |

For agents that support installable skills, add the dedicated live-control
workflow:

```bash
npx skills add 2bbb/maxforge --skill maxforge-mcp
```

Use the separate `maxforge` skill for offline DSL authoring and `.maxpat`
compilation. A skill supplies instructions only: it does not install or start
`maxforge-mcp`, and it does not install the native external.

The safe live sequence is fixed:

1. `maxforge_help` (`workflow`)
2. `maxforge_status` when connection/process state is uncertain
3. `maxforge_catalog` before using a custom external or abstraction
4. `maxforge_list_patches`
5. create a blank target with `maxforge_create_patch`, or open an existing file
   with `maxforge_open_patch`, only when a separate target is required
6. `maxforge_inspect_patch`
7. if managed changes exist, `maxforge_reconcile_patch` with complete desired DSL
8. require `canApply: true`, then review warnings and destructive operations
9. otherwise use `maxforge_compile_plan` for the ordinary no-drift path
10. `maxforge_apply_dsl` with the same target and desired DSL; set
   `manualChanges: "merge"` only after successful reconciliation
11. verify acknowledgement revision, inspect again, and call
    `maxforge_save_patch` only when persistence is intended

Do not collapse this into a direct apply. Titles are not identities, DSL is not
an imperative edit, and a timeout is not proof that Max remained unchanged.

## Tools

### `maxforge_help`

Returns structured agent instructions for one of the four topics above. It does
not require Max to be running and is safe to call before any target registers.
Call `recovery` before retrying an ambiguous failure.

### `maxforge_status`

Reports:

- raw connected Max client count;
- every registered patch's `patcherId`, scope, controller capability, path,
  and revision;
- the last revision received for each `patcherId:scope` target;
- graph revisions remembered by the current MCP process;
- targets with a post-apply structural inspection baseline;
- effective object-catalog digest, configured source files, and built-in,
  custom, and abstraction counts.

Raw WebSocket connections are not operation targets. A client becomes
addressable only after `maxforge.sync` sends `maxforge.registered`. Apply and
inspection route to the explicit `patcherId`; multiple registered patches are
therefore not ambiguous.

### `maxforge_catalog`

Reads the compiler catalog loaded by this MCP process. It does not require Max
to be running and never mutates a patch.

Arguments:

- `query` — optional case-insensitive substring filter;
- `includeBuiltins` — include the bundled database; defaults to `false`, so an
  unfiltered call reports project declarations only;
- `limit` — result limit from 1 to 200, default 50.

Each result identifies the object as built-in, external, or abstraction and
reports serialization class, port metadata, dynamic status, and source file.
Use the catalog digest from this tool/status when diagnosing different agent
results across process restarts. Do not treat a listed object as proof that Max
can instantiate it; maxforge deliberately avoids side-effectful runtime probes.

### `maxforge_reload_catalog`

Reloads the catalog configured at MCP startup without restarting the server or
dropping live Max registrations. Maxforge parses and validates the complete
replacement before switching the compiler database and reported digest
together. A failed reload leaves the previous catalog active. After editing a
configured catalog file, reload it and verify the new digest with
`maxforge_catalog` before compiling.

### `maxforge_list_patches`

Returns the currently registered patch targets. Use this before inspection or
mutation instead of guessing a window from its title. `patcherId` is the stable
transport identity; titles and filenames are display metadata and may collide.

### `maxforge_create_patch`

Creates a new top-level, unsaved Max patch and waits for both native creation
acknowledgement and registration of the new patch's own WebSocket client.

Arguments:

- `patcherId` — unique target ID. Letters or underscore first; letters,
  digits, underscores, and hyphens thereafter.
- `scope` — managed namespace for the new patch.
- `title` — visible Max window title.

Exactly one registered patch must have controller capability. The distributed
bridge example is that controller; generated patches are not controllers.
Creation is implemented by `maxforge.sync` with
`jpatcher_load_frombuffer`. The generated patch contains one configured
`maxforge.sync` object and no bootstrap patch cords. It does not use JavaScript
or `node.script`.

### `maxforge_open_patch`

Opens an existing `.maxpat` using a controller on the Max host, injects one
configured `maxforge.sync`, marks the patch dirty, and waits for the new client
to register. `path` must be an absolute Max-host path; in LAN mode it is not an
MCP-host path. A file that already contains `maxforge.sync` is rejected: open
that file normally and use its configured `patcherId` instead.

### `maxforge_save_patch`

Saves a registered patch through Max's patcher `write` method. Omit `path` only
when the patch already has a file path. Supplying an absolute `.maxpat` path is
save-as; an existing destination is rejected unless `overwrite: true` is
explicit. The tool succeeds only after Max reports a non-empty path and a clean
dirty flag. Applying DSL does not save automatically.

### `maxforge_close_patch`

Closes a registered top-level patch through the documented patcher `dispose`
method. A dirty patch is rejected unless `discard: true` is explicit. Save
first when changes must survive. The acknowledgement is sent before deferred
disposal so the MCP client does not mistake the expected disconnect for a
transport failure.

### `maxforge_inspect_patch`

Reads the live patcher graph through `maxforge.sync`; it does not use a
screenshot, accessibility API, saved `.maxpat`, or Max window state.

Arguments:

- `patcherId` — registered target patch.
- `scope` — the scope advertised by that patch.

The result includes:

- patcher title, file path, dirty/locked/presentation state;
- every box's nested path, runtime ID, scripting name, Max class, text/comment,
  position, bounded serializable attributes, and maxforge ownership;
- source/destination endpoints and exposed serializable attributes for every
  patch cord;
- exact box and connection changes since the last acknowledged apply;
- separate managed and unmanaged change counts.

The comparison baseline is captured immediately after a successful
`maxforge_apply_dsl`. Inspection is read-only and does not advance that
baseline. Before the first apply, or after the MCP process restarts,
`comparisonAvailable` is `false`: the full live snapshot remains available,
but the server cannot honestly claim which prior action caused its state.

### `maxforge_reconcile_patch`

Performs a read-only three-way merge between:

1. the agent's previous desired managed graph;
2. the current live Max snapshot;
3. the next complete `desiredDsl`.

It preserves a live edit when desired DSL did not change the same field, and
preserves a desired edit when Max did not change that field. For example, a
human can move `osc` while the agent changes its arguments, or change `osc`
while the agent adds an unrelated `gain` box. A different live and desired
change to the same field is a conflict. Deleting a box on one side while the
other side changes it is also a conflict.

The result contains `canApply`, a structured `conflicts` array, and an ordered
plan only when the merge is safe. This tool never mutates Max. Do not convert
`canApply: false` into an overwrite: inspect the conflict and make the intended
winner explicit in Max or in the next baseline/DSL.

The acknowledged merged graph is tracked separately and supplies concrete live
metadata plus the native `baseRevision`. Plan operations describe the actual
live graph to merged graph transition. This split is required because manual
Max edits do not advance `@revision_state`, while the agent's previous DSL may
intentionally omit a human edit preserved by an earlier merge.

### `maxforge_compile_plan`

Compiles complete `desiredDsl` into a read-only `PatchPlan`.

Arguments:

- `patcherId` — registered target whose remembered/live state is used.
- `scope` — managed namespace.
- `desiredDsl` — complete desired state, not an imperative edit.
- `currentDsl` — optional current desired state. When omitted, the tool uses
  the graph remembered by this MCP process; it uses empty state only when the
  scope is not initialized.

### `maxforge_apply_dsl`

Compiles a diff, sends the raw plan to Max, and returns only after
`maxforge.sync` acknowledges the exact target revision.

`patcherId` and `scope` are both required. Graph state and inspection baselines
are keyed by both values, so two windows may use the same scope without sharing
state.

The remembered graph advances only after that acknowledgement. A timeout,
disconnect, parse error, validation error, or Max mutation error leaves the
MCP graph state unchanged.

After acknowledgement, the service requests another live snapshot and records
it as the next comparison baseline. If that second read fails, the apply still
returns success with `baselineCaptured: false` and `baselineWarning`; reporting
the already-applied mutation as a failure would invite an unsafe retry.

`manualChanges` defaults to `"reject"`, retaining the strict behavior: any
manual structural change touching a managed box or one of its patch cords
rejects mutation. After `maxforge_reconcile_patch` returns `canApply: true` for
the exact same target and DSL, pass `manualChanges: "merge"` to preserve the
non-conflicting live changes. The apply repeats inspection and reconciliation;
it does not trust a stale preview. The resulting plan carries the inspected
`baseStructureToken`; `maxforge.sync` recomputes it immediately before native
validation and rejects the request if any box or cord changed in the interval.
`manualChangesMerged` reports the managed change count used by that apply.

The service tracks the acknowledged merged graph separately from the agent's
last submitted desired graph. This prevents a later ordinary apply using stale
DSL from silently reverting a previously preserved human edit. While those
graphs differ, ordinary compile/apply is rejected; use reconciliation again, or
provide a complete `currentDsl` that already includes every preserved edit.
After a merged apply, inspect and update the working DSL if future sessions must
be restart-safe.

Standalone unmanaged edits remain outside the managed graph. A cord between an
unmanaged box and a managed box is preserved while that managed box remains in
place. Reconciliation rejects a desired deletion or structural recreation that
would destroy such a cord.

## Tool call examples

MCP clients normally render the tool schema directly. The following objects are
tool arguments, not raw JSON-RPC envelopes.

Inspect a target selected from `maxforge_list_patches`:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated"
}
```

Preview and then apply the same complete desired state:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated",
  "desiredDsl": "patch \"Generated\"\nbutton_0 = button at(40, 80)\nvalue_0 = number at(80, 80)\nbutton_0 -> value_0"
}
```

If inspection reported managed edits, pass this same object to
`maxforge_reconcile_patch`. Apply only when it returns `canApply: true`; then
pass the same object to `maxforge_apply_dsl` with `manualChanges` added:

```json
{ "manualChanges": "merge" }
```

Review `plan.operations` and `warnings` from `maxforge_compile_plan`. A
successful `maxforge_apply_dsl` result has this top-level shape:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated",
  "baseRevision": "<64 lowercase hex characters>",
  "targetRevision": "<64 lowercase hex characters>",
  "operationCount": 3,
  "acknowledgement": {
    "type": "maxforge.applied",
    "revision": "<same value as targetRevision>",
    "operations": 3
  },
  "baselineCaptured": true,
  "manualChangesMerged": 0,
  "warnings": []
}
```

Treat success as all of the following:

- the tool result is not an MCP error;
- `acknowledgement.revision` equals `targetRevision`;
- the acknowledgement operation count matches `operationCount`;
- post-apply inspection reports the expected graph.

If `baselineCaptured` is `false`, the acknowledged apply still succeeded. Read
`baselineWarning`, inspect explicitly, and do not repeat the apply merely to
obtain a comparison baseline.

## Max patch object

Use `examples/mcp_bridge/maxforge_mcp_bridge.maxpat`. Its complete functional
content is:

```max
maxforge.sync @host 127.0.0.1 @port 8766 @scope agent_demo @patcher_id maxforge_bridge @controller 1
```

The checked-in `.maxdsl` escapes each leading `@` as `\@`, keeping these values
in the Max object's initialization text instead of writing unrelated box JSON
keys. The generated `.maxpat` contains exactly one box and zero patch cords.
`maxforge.sync` waits until its containing top-level patcher has a visible view,
connects, and registers automatically. The resulting `maxforge.registered`
event advertises identity, metadata, capability, and either the live revision
or `null`.

Transport lifecycle can also be controlled with `connect`, `disconnect`, and
`restart`. `status` reports the current connection state. Attributes
`@reconnect` and `@reconnect_interval` control retry behavior.

`maxforge_create_patch` sends a correlated creation request only to the
registered controller. The generated patch connects independently and
registers its own `patcherId`; subsequent apply and inspection requests go
directly to that patch rather than through the controller.

The same controller handles `maxforge_open_patch`. Save and close requests are
sent directly to the selected patch's own `maxforge.sync`, not proxied through
the controller.

`bbb.agent` is a recursive build-time submodule only. Max users do not install
`bbb.agent.hub` or run the `bbb.agent` helper for this flow.

## Persistent state and restart recovery

Maxforge atomically persists acknowledged managed graphs, agent-intent graphs,
inspection baselines, and in-flight apply records. The default file is scoped by
WebSocket port under `~/.maxforge`; set an absolute `MAXFORGE_STATE_FILE` when an
MCP client needs an explicit location.

Before sending a plan, Maxforge writes an in-flight record containing both base
and target revisions. If acknowledgement is lost, the next process waits for the
same patch to reconnect and accepts only those two outcomes: base means no
mutation was committed; target means the acknowledged graph is promoted. Any
third revision is reported as ambiguous rather than guessed.

`maxforge_status` reports the persistence path and unresolved scopes. A normal
restart retains comparison history and does not require `currentDsl`.

If persistence was explicitly disabled, the state file was removed, or the MCP
client switched ports/files, the old fallback still applies: provide the exact
previous complete DSL as `currentDsl` once. A malformed state file fails startup
instead of silently discarding concurrency state.

Do not guess `currentDsl`, reset the Max revision attribute, delete state merely
to bypass a conflict, or pretend the scope is empty. Those actions defeat
optimistic concurrency.

## Troubleshooting

| Symptom | Likely cause | Required action |
|---|---|---|
| `maxforge_list_patches` returns no targets | Max is closed, the controller patch is closed, the external is missing, or registration has not completed | Call `maxforge_status`; open the controller patch and verify `maxforge.sync` in Max |
| Raw client count is nonzero but no patch is registered | WebSocket connected before a valid registration event | Check `patcherId`, scope, and Max console errors; do not target the raw connection |
| Port 8766 is already in use | Another MCP server owns the bridge port | Stop the duplicate server or set the same alternate `MAXFORGE_WS_PORT`/`@port` on both sides |
| Patch creation reports no controller | No registered patch has `controller: true` | Open the distributed controller patch and list patches again |
| Patch creation reports multiple controllers | More than one controller patch is open | Leave exactly one controller registered before creating a patch |
| Duplicate `patcherId` | Two live patches advertise the same transport identity | Change one `@patcher_id`; titles are irrelevant |
| Process has no graph state for an initialized revision | Persistence was disabled, removed, or pointed at another file | Restore the matching state file or pass the exact previous complete DSL as `currentDsl` once |
| Pending scope appears in status | Apply acknowledgement was lost | Reconnect that exact patch; Maxforge resolves only the recorded base or target revision |
| Current DSL revision does not match Max | `currentDsl`, scope, or target is wrong | Stop; recover the exact prior DSL instead of forcing empty state |
| Managed manual changes block ordinary apply | `manualChanges` defaults to `reject` | Call `maxforge_reconcile_patch`; apply the same DSL with `manualChanges: "merge"` only when `canApply` is true |
| Reconciliation reports conflicts | Both sides changed the same field, one changed a box the other deleted, a new reserved identity appeared, or a desired replacement would destroy an unmanaged cord | Resolve the listed conflict explicitly; do not force or retry the apply |
| Apply times out or transport disconnects | Acknowledgement is missing; Max may be unchanged, applied, or partially mutated | Do not retry; call status and inspect first |
| `baselineCaptured: false` | Max acknowledged apply but the follow-up snapshot failed | Treat apply as successful, inspect explicitly, and do not repeat solely for baseline capture |
| `comparisonAvailable: false` | No baseline exists in this MCP process | Use the full snapshot; do not invent historical changes |

## Failure contract

- WebSocket transport is unauthenticated only in its default loopback mode.
  Non-loopback binding requires `MAXFORGE_WS_TOKEN`, and Max must send the same
  `@token` before registration.
- LAN authentication uses plaintext WebSocket and is not intended for direct
  Internet exposure.
- A duplicate live `patcherId` is rejected rather than silently replacing the
  existing target.
- WebSocket messages are bounded to 4 MiB; very large patch snapshots fail
  rather than consuming unbounded memory.
- Only exact `maxforge_<scope>_obj_...` scripting names are managed.
- The complete plan is validated before mutation.
- Protocol v1 is not transactional. A runtime failure may leave partial patch
  mutation; the revision is not advanced.
- Structural inspection covers box identity, varname, class, text/comment,
  patching rectangle, nesting, patch cords, and dirty user-readable/writable
  attributes whose values are serializable Max atoms. It excludes volatile
  `value`, identity/file/pointer fields, opaque attributes, and nested data so
  normal performance changes are not reported as patch edits.
- A comparison baseline is persisted when state persistence is enabled. Without
  one, Maxforge reports the current graph but does not fabricate change history.
- Reconciliation preserves observed text/comment, position, supported
  attributes, deletion, and patch-cord edits on existing managed identities.
  Opaque, runtime-only, or structured attributes omitted from inspection remain
  outside the merge model.
- Moving a managed box into a different patcher path is not treated as an
  identity-preserving edit. Represent the intended reparenting in complete DSL
  and resolve the resulting delete/add conflict explicitly.
- A box manually given a new reserved `maxforge_<scope>_obj_...` identity is
  reported as `managed_box_added`, not silently adopted. Define it in DSL or
  remove the reserved scripting name first.
- Inspection and apply are separate requests, but MCP apply plans bind them with
  `baseStructureToken`. A human edit after apply-side inspection changes the
  token, so the native external rejects the stale plan before mutation.

See [`patch-sync.md`](patch-sync.md) for the plan and ownership protocol.
