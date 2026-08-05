# maxforge MCP control

`maxforge-mcp` lets an MCP-capable agent replace a scope-owned Max patch graph
from complete desired DSL. It does not run an agent or JavaScript inside Max.

## Architecture

```text
MCP client
  | stdio
maxforge-mcp (Node.js 20+)
  | ws://127.0.0.1:8766
one maxforge.sync per registered patch (native Max external)
  | Max SDK
containing patcher
```

The boundary is intentional:

- MCP, DSL compilation, diffing, and session state belong in Node.js.
- Loopback transport, request routing, patcher ownership validation, and Max SDK
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
| `MAXFORGE_WS_HOST` | `127.0.0.1` | WebSocket bind host |
| `MAXFORGE_WS_PORT` | `8766` | WebSocket port used by `maxforge.sync` |
| `MAXFORGE_APPLY_TIMEOUT_MS` | `5000` | Max apply, inspection, or patch creation response timeout |

The host is rejected unless it is exactly `127.0.0.1` or `::1`. Hostnames are
not accepted because a hostname is not itself proof of a loopback bind. There
is no supported public-network mode.

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
3. `maxforge_list_patches`
4. `maxforge_inspect_patch`
5. `maxforge_compile_plan` with complete desired DSL
6. review warnings and destructive operations
7. `maxforge_apply_dsl` with the same target and desired DSL
8. verify acknowledgement revision and inspect again

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
- targets with a post-apply structural inspection baseline.

Raw WebSocket connections are not operation targets. A client becomes
addressable only after `maxforge.sync` sends `maxforge.registered`. Apply and
inspection route to the explicit `patcherId`; multiple registered patches are
therefore not ambiguous.

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

### `maxforge_inspect_patch`

Reads the live patcher graph through `maxforge.sync`; it does not use a
screenshot, accessibility API, saved `.maxpat`, or Max window state.

Arguments:

- `patcherId` — registered target patch.
- `scope` — the scope advertised by that patch.

The result includes:

- patcher title, file path, dirty/locked/presentation state;
- every box's nested path, runtime ID, scripting name, Max class, text,
  position, and maxforge ownership;
- source/destination endpoints for every patch cord;
- exact box and connection changes since the last acknowledged apply;
- separate managed and unmanaged change counts.

The comparison baseline is captured immediately after a successful
`maxforge_apply_dsl`. Inspection is read-only and does not advance that
baseline. Before the first apply, or after the MCP process restarts,
`comparisonAvailable` is `false`: the full live snapshot remains available,
but the server cannot honestly claim which prior action caused its state.

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

When a baseline exists, apply first inspects Max. Any manual structural change
that touches a managed box or one of its patch cords rejects mutation until the
caller inspects and manually restores the post-apply managed structure.
Inspection does not accept or reset the baseline, and there is currently no MCP
operation that adopts managed manual edits. Standalone unmanaged edits are
reported but do not block managed mutation.

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

`bbb.agent` is a recursive build-time submodule only. Max users do not install
`bbb.agent.hub` or run the `bbb.agent` helper for this flow.

## Restart and stale-state rule

A revision hash proves identity but cannot reconstruct a graph.

If `maxforge-mcp` restarts while a registered patch retains an initialized
scope, the server has no graph from which to produce a safe diff. The next
`maxforge_apply_dsl` for that `patcherId:scope` target must include the previous
complete DSL as `currentDsl`. The server verifies its revision against Max
before sending a plan and then resumes remembered-state operation after
acknowledgement.

The same limitation applies to inspection history. A restarted process can
read the complete current patch, but it has no pre-restart snapshot, so it
returns `comparisonAvailable: false` until an apply establishes a new baseline.

Do not guess `currentDsl`, reset the revision attribute, or pretend the scope is
empty. Those actions defeat optimistic concurrency.

## Troubleshooting

| Symptom | Likely cause | Required action |
|---|---|---|
| `maxforge_list_patches` returns no targets | Max is closed, the controller patch is closed, the external is missing, or registration has not completed | Call `maxforge_status`; open the controller patch and verify `maxforge.sync` in Max |
| Raw client count is nonzero but no patch is registered | WebSocket connected before a valid registration event | Check `patcherId`, scope, and Max console errors; do not target the raw connection |
| Port 8766 is already in use | Another MCP server owns the bridge port | Stop the duplicate server or set the same alternate `MAXFORGE_WS_PORT`/`@port` on both sides |
| Patch creation reports no controller | No registered patch has `controller: true` | Open the distributed controller patch and list patches again |
| Patch creation reports multiple controllers | More than one controller patch is open | Leave exactly one controller registered before creating a patch |
| Duplicate `patcherId` | Two live patches advertise the same transport identity | Change one `@patcher_id`; titles are irrelevant |
| Process has no graph state for an initialized revision | `maxforge-mcp` restarted while Max stayed open | Pass the exact previous complete DSL as `currentDsl` once |
| Current DSL revision does not match Max | `currentDsl`, scope, or target is wrong | Stop; recover the exact prior DSL instead of forcing empty state |
| Managed manual changes block apply | A managed box or a cord touching it changed after the baseline | Inspect the exact changes and manually restore the post-apply structure; there is no adopt operation |
| Apply times out or transport disconnects | Acknowledgement is missing; Max may be unchanged, applied, or partially mutated | Do not retry; call status and inspect first |
| `baselineCaptured: false` | Max acknowledged apply but the follow-up snapshot failed | Treat apply as successful, inspect explicitly, and do not repeat solely for baseline capture |
| `comparisonAvailable: false` | No baseline exists in this MCP process | Use the full snapshot; do not invent historical changes |

## Failure contract

- WebSocket transport is loopback-only but unauthenticated.
- A duplicate live `patcherId` is rejected rather than silently replacing the
  existing target.
- WebSocket messages are bounded to 4 MiB; very large patch snapshots fail
  rather than consuming unbounded memory.
- Only exact `maxforge_<scope>_obj_...` scripting names are managed.
- The complete plan is validated before mutation.
- Protocol v1 is not transactional. A runtime failure may leave partial patch
  mutation; the revision is not advanced.
- Structural inspection currently covers box identity, varname, class, text,
  patching rectangle, nesting, and patch cords. It deliberately excludes
  volatile runtime values and arbitrary object attributes to avoid reporting
  normal performance changes as patch edits.
- A comparison baseline is process-local. Without one, Maxforge reports the
  current graph but does not fabricate change history.

See [`patch-sync.md`](patch-sync.md) for the plan and ownership protocol.
