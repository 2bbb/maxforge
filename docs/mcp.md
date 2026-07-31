# maxforge MCP control

`maxforge-mcp` lets an MCP-capable agent replace a scope-owned Max patch graph
from complete desired DSL. It does not run an agent or JavaScript inside Max.

## Architecture

```text
MCP client
  | stdio
maxforge-mcp (Node.js 20+)
  | ws://127.0.0.1:8766
one or more bbb.agent.hub instances (native Max external)
  | correlated request / compact JSON event
one maxforge.sync per registered patch (native Max external)
  | Max SDK
containing patcher
```

The split is intentional:

- MCP, DSL compilation, diffing, and session state belong in Node.js.
- The generic localhost transport belongs in `bbb.agent.hub`.
- Patcher ownership validation and mutation belong in `maxforge.sync`.

Putting MCP or a WebSocket stack inside `maxforge.sync` would couple protocol
churn and network threading to patch mutation. Duplicating `bbb.agent.hub`
inside this repository would create a second transport implementation with no
new capability.

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

Environment variables:

| Name | Default | Meaning |
|---|---:|---|
| `MAXFORGE_WS_HOST` | `127.0.0.1` | WebSocket bind host |
| `MAXFORGE_WS_PORT` | `8766` | WebSocket port used by `bbb.agent.hub` |
| `MAXFORGE_APPLY_TIMEOUT_MS` | `5000` | Max apply, inspection, or patch creation response timeout |

The host is rejected unless it is exactly `127.0.0.1` or `::1`. Hostnames are
not accepted because a hostname is not itself proof of a loopback bind. There
is no supported public-network mode.

## Tools

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
`jpatcher_load_frombuffer`. The generated patch contains native
`bbb.agent.hub` and `maxforge.sync` wiring and does not use JavaScript or
`node.script`.

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
caller inspects and reconciles the state. Standalone unmanaged edits are
reported but do not block managed mutation.

## Max patch wiring

Use `examples/mcp_bridge/maxforge_mcp_bridge.maxpat`. Its essential message
flow is:

```text
bbb.agent.hub outlet 1
  -> route data
  -> prepend apply
  -> maxforge.sync

maxforge.sync
  -> route event
  -> prepend send
  -> bbb.agent.hub
```

Before connecting, the patch explicitly configures `scope`, `patcher_id`, and
`controller` on `maxforge.sync`. On `status connected`, it sends `register`.
The resulting `maxforge.registered` event advertises identity, metadata,
capability, and either the live revision or `null`.

`maxforge_create_patch` sends a correlated creation request only to the
registered controller. The generated patch connects independently and
registers its own `patcherId`; subsequent apply and inspection requests go
directly to that patch rather than through the controller.

`bbb.agent.hub` comes from the separate
[`bbb.agent`](https://github.com/2bbb/bbb.agent) package. Its helper service is
not used for this flow.

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
