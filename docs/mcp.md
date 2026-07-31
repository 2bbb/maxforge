# maxforge MCP control

`maxforge-mcp` lets an MCP-capable agent replace a scope-owned Max patch graph
from complete desired DSL. It does not run an agent or JavaScript inside Max.

## Architecture

```text
MCP client
  | stdio
maxforge-mcp (Node.js 20+)
  | ws://127.0.0.1:8766
bbb.agent.hub (native Max external)
  | raw PatchPlan or inspection request / compact JSON event
maxforge.sync (native Max external)
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
| `MAXFORGE_APPLY_TIMEOUT_MS` | `5000` | Max apply or inspection response timeout |

The host is rejected unless it is exactly `127.0.0.1` or `::1`. Hostnames are
not accepted because a hostname is not itself proof of a loopback bind. There
is no supported public-network mode.

## Tools

### `maxforge_status`

Reports:

- connected Max client count;
- the last revision event received for each scope;
- graph revisions remembered by the current MCP process;
- scopes with a post-apply structural inspection baseline.

Mutation requires exactly one connected Max client. Zero is disconnected; more
than one is ambiguous and rejected.

### `maxforge_inspect_patch`

Reads the live patcher graph through `maxforge.sync`; it does not use a
screenshot, accessibility API, saved `.maxpat`, or Max window state.

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

- `scope` — managed namespace.
- `desiredDsl` — complete desired state, not an imperative edit.
- `currentDsl` — optional current desired state. When omitted, the tool uses
  the graph remembered by this MCP process; it uses empty state only when the
  scope is not initialized.

### `maxforge_apply_dsl`

Compiles a diff, sends the raw plan to Max, and returns only after
`maxforge.sync` acknowledges the exact target revision.

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

On `status connected`, the patch sends `revision` to `maxforge.sync`. This
seeds the MCP process with either the live revision or `null`.

`bbb.agent.hub` comes from the separate
[`bbb.agent`](https://github.com/2bbb/bbb.agent) package. Its helper service is
not used for this flow.

## Restart and stale-state rule

A revision hash proves identity but cannot reconstruct a graph.

If `maxforge-mcp` restarts while Max retains an initialized scope, the server
has no graph from which to produce a safe diff. The next `maxforge_apply_dsl`
must include the previous complete DSL as `currentDsl`. The server verifies its
revision against Max before sending a plan and then resumes remembered-state
operation after acknowledgement.

The same limitation applies to inspection history. A restarted process can
read the complete current patch, but it has no pre-restart snapshot, so it
returns `comparisonAvailable: false` until an apply establishes a new baseline.

Do not guess `currentDsl`, reset the revision attribute, or pretend the scope is
empty. Those actions defeat optimistic concurrency.

## Failure contract

- WebSocket transport is loopback-only but unauthenticated.
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
