# Managed patch synchronization

This document defines the experimental desired-state protocol used to synchronize
a maxforge DSL fragment with a live Max patcher.

## Boundary

The DSL frontend is one input adapter. It compiles desired text into the shared
`PatchGraph` domain, which produces a `PatchPlan`; neither the graph protocol nor
the native external interprets DSL. The included `maxforge.sync` external
validates and applies plans through the Max SDK.

```text
DSL -> PatchGraph -> diffPatchGraphs(current, desired) -> PatchPlan -> Max consumer
```

The protocol version is currently `1`.

See [Architecture](architecture.md) for the dependency rules between the DSL,
patch domain, MCP application service, WebSocket transport, and native host.

## Scope and ownership

Each graph has a scope such as `voices`. Scope names must match
`^[A-Za-z_]\w*$`.

Managed object scripting names use the reserved namespace:

```text
maxforge_<scope>_obj_<dsl-name>
```

For example, DSL object `osc_3` in scope `voices` becomes
`maxforge_voices_obj_osc_3`.

Only varnames that exactly match this grammar for the active scope belong to the
graph. A shorter prefix scope does not own a longer scope (`foo` does not own
`foo_bar`). A consumer must not modify other objects. Managed graph compilation
rejects `@varname` because overriding it would destroy ownership tracking.

The reserved varname is the ownership marker in protocol version 1. The native
consumer therefore treats a manually renamed object as scope-owned. The MCP
reconciler does **not** silently adopt a newly introduced reserved identity,
because inspection does not contain enough object metadata to reconstruct a
safe `PatchGraph`; it reports `managed_box_added` instead.

## Stable identity

The normal compiler derives Max box IDs from DSL names:

```text
osc_3 -> obj-osc_3
```

Names are unique within each patcher, so inserting or reordering unrelated
declarations does not change existing IDs. Nested patchers have their own local
ID namespace and are addressed by `targetPath`.

## Revisions

Every graph contains a SHA-256 revision of its canonical desired state. Box and
connection declaration order does not affect the revision.

`PatchGraph` is exposed as readonly state. Use `createPatchGraph()` when
constructing a graph programmatically so its revision matches its contents; do
not mutate a graph after creation.

A plan contains:

- `baseRevision` — revision the consumer must currently hold.
- `targetRevision` — revision after successful application.
- optional `baseStructureToken` — 16-character lowercase hexadecimal token for
  the exact inspected live box/connection structure.
- optional `rollbackOperations` — reverse ordered operations generated from
  target state back to base state.

The consumer must reject a plan when `baseRevision` does not match its current
managed revision. When `baseStructureToken` is present, it must also snapshot
the live patch immediately before validation and reject a token mismatch before
any operation runs. MCP apply plans include this token; standalone CLI plans may
omit it. A revision is optimistic concurrency control, not rollback.

An empty operation list may still advance the revision when MCP adopts managed
human edits that already exist in Max. That acknowledgement is safe only when
the service reconstructed the target graph from the live snapshot and bound the
plan to that snapshot's `baseStructureToken`. It is not a generic revision-reset
mechanism and must not be used to acknowledge an uninspected graph.

## Operations

`PatchPlan.operations` is ordered and JSON-serializable:

1. `disconnect` obsolete or replaced connections.
2. `delete` obsolete or structurally changed boxes, deepest patchers first.
3. `create` new or structurally changed boxes, parent patchers first.
4. `set` mutable text, comments, positions, and serializable attributes.
5. `connect` new or restored connections.

Each operation contains a `targetPath` of parent subpatcher scripting names.
An empty path targets the patcher containing the Max-side consumer.

Message/comment text, inlet/outlet comments, positions, and changed scalar or
flat-array attributes emit `set` and preserve the object instance. `newobj`
text changes still recreate the object because they can change class and port
shape. Class/port changes, attribute removal, and unsupported structured
attribute values also use replacement rather than an unsafe partial update.

## Consumer requirements

A correct consumer must:

- Validate the protocol version, scope, revision, and all operations before
  mutating the patch.
- Resolve every `targetPath` and managed scripting name before destructive work.
- Apply operations on Max's main thread.
- Reject references outside the active managed scope.
- Update its current revision only after every operation succeeds.
- Validate supplied reverse operations against the simulated target state
  before mutation.

The Max SDK does not make arbitrary external-driven patcher mutations undoable.
Current maxforge plans therefore carry reverse operations and the native
consumer attempts them after a forward operation fails. This is best-effort
managed-graph recovery, not transaction safety: recreated boxes receive new
runtime IDs, opaque object state is not restored, and patch cords to unmanaged
objects may already have been removed. Always inspect after an apply error.

## maxforge.sync

Build the native consumer:

```bash
git submodule update --init --recursive
cmake -S . -B build
cmake --build build
```

`maxforge.sync` supports:

- automatic WebSocket connection and patch registration after the
  containing top-level patcher becomes visible;
- `connect`, `disconnect`, and `restart` — control the native transport;
- `status` — output the current transport state;
- `apply <compact-json>` — validate and apply a serialized `PatchPlan`.
- `validate <compact-json>` — validate without mutation.
- `applydict <name>` — validate and apply a named Max dictionary.
- `inspect [request-id]` — emit a structural snapshot of the containing
  patcher without mutating it.
- `register` — advertise the containing patcher's stable MCP identity,
  scope, revision, metadata, and controller capability.
- `revision` — output the consumer's current revision.
- `@scope <name>` — select the exact managed namespace.
- `@patcher_id <name>` — select the stable MCP routing identity.
- `@controller 0|1` — allow or deny native top-level patch creation requests.
- `@revision_state <hash>` — persisted optimistic concurrency state.
- `@host <address>` — select the MCP host; defaults to `127.0.0.1`.
- `@port <1..65535>` — select the MCP WebSocket port.
- `@token <value>` — authenticate a LAN connection. Required when `@host` is
  not the literal loopback address `127.0.0.1` or `::1`.
- `@reconnect 0|1` — enable or disable automatic reconnect.
- `@reconnect_interval <100..60000>` — set reconnect delay in milliseconds.

Tokens contain 1–256 URL-safe characters: letters, digits, `.`, `_`, `~`, and
`-`. Authentication is sent before registration and is not mirrored to the
external's event outlet. The token is still stored as plain object text when
the patch is saved.

The external sends machine-readable events directly over its WebSocket
connection and mirrors them on the outlet as `event <compact-json>`:

- `maxforge.registered` in response to `register`.
- `maxforge.applied` after all operations succeed.
- `maxforge.revision` in response to `revision`; an uninitialized revision is
  encoded as `null`.
- `maxforge.snapshot` in response to `inspect` or a correlated
  `maxforge.inspect.request`.
- `maxforge.error` when parsing, validation, or mutation fails.
- `maxforge.patch.created` after a requested top-level patch is loaded.

Human-readable `status`, `applied`, `revision`, and `error` messages remain
available on the same outlet. Failures are also sent through Max's error API,
so they use error severity in the Max Console rather than appearing as ordinary
posts.

The MCP transport sends inspection requests directly to the registered
external:

```json
{
  "type": "maxforge.inspect.request",
  "requestId": "correlation-id",
  "patcherId": "synth_patch",
  "scope": "voices"
}
```

MCP apply requests use the same correlation and routing fields and contain the
plan under `plan`. Every applied, snapshot, and error response carries the
request ID and patcher ID, preventing one patch's response from satisfying
another patch's request.

A controller can receive:

```json
{
  "type": "maxforge.create_patch.request",
  "requestId": "correlation-id",
  "patcherId": "generated_patch",
  "scope": "generated",
  "title": "Generated patch"
}
```

The controller attribute must be enabled. `maxforge.sync` loads an unsaved
top-level patch through the Max SDK, triggers its bootstrap loadbang, and
acknowledges creation. The generated patch inherits the controller's host,
port, and token, then registers through its own native WebSocket connection.

The snapshot response contains root patcher metadata plus flattened boxes and
connections, and a top-level `structureToken` derived only from that sorted
box/connection structure. Patcher title, file path, dirty state, lock state, and
presentation mode do not affect the token. `targetPath` identifies nested
patchers. Box records include `runtimeId`, `varName`, `maxclass`,
`patchingRect`, `managed`, optional `text`/`comment`, and an `attributes`
object. Connection records include both endpoint runtime IDs, varnames, port
indices, and their own `attributes` object.

Attribute inspection is intentionally bounded. The external serializes only
dirty attributes that Max exposes as both user-readable and user-writable, and
only when the value is a number, string, or flat array of those atoms. Identity,
class, file-path, patcher-pointer, text/comment/position fields handled
elsewhere, and the volatile `value` attribute are excluded. The same rule is
applied to patch cords, so Max versions or objects that expose saved cord
attributes can report changes such as hidden state, color, or midpoints without
turning ordinary UI/DSP values into patch edits.

The first apply is accepted only when the revision state is empty and the
configured scope contains no managed root boxes. After success,
`revision_state` advances to `targetRevision`. It is not advanced when an
operation fails.

The consumer parses and validates all operations before mutation. Validation
simulates create/delete ordering so a plan can create a parent subpatcher and
then target its contents. When a plan carries `baseStructureToken`, the consumer
checks it before both `validate` and `apply`. Mutation occurs synchronously on
Max's main thread.

Generate plan JSON with the CLI:

```bash
maxforge plan desired.maxdsl --scope voices --compact -o plan.json
maxforge plan next.maxdsl --scope voices --current current.maxdsl -o plan.json
```

`--current` also accepts a `.maxpat` snapshot. Only boxes already carrying exact
managed varnames for the selected scope are imported from such a snapshot.

See `examples/max_sync/` for a Max 9 smoke test. The example imports
`managed_plan.json` into a named `dict`, applies it with `applydict`, and creates
both root objects and objects inside `p generated_bank`.

## Current limitations

- MCP graph, intent, baseline, and in-flight apply state is atomically persisted
  by default. `currentDsl` re-seeding is only required when persistence was
  disabled or the matching state file is unavailable.
- New patch creation requires exactly one registered controller patch.
- A `PatchPlan` is not atomic by itself.
- Runtime/standalone Max support is not guaranteed.
- MCP comparison baselines begin after an acknowledged apply and survive normal
  process restarts. A snapshot cannot reconstruct edit history predating the
  first stored baseline.
- Human-edit review classifies observed differences but cannot prove intent.
  Related differences are correlated into edit clusters by patcher path and
  shared object identity; this is structural correlation, not edit-history or
  semantic-intent reconstruction. Independent actions that happen to touch the
  same object cannot be separated from one snapshot pair.
  Token-bound adoption can accept managed edits without replaying them; it does
  not automatically claim unmanaged boxes. It returns a lossless explicit
  working DSL, but the agent must replace its own source with that result.
- Native edit observation provides bounded ordering evidence only while both
  `maxforge.sync` and the MCP bridge remain connected. Notifications are
  debounced for 75 ms and emitted only when a full structural snapshot token
  changes. Agent-authored plan application is suppressed. Multiple edits in a
  debounce window collapse into one observation, notification causes may be
  `unknown`, and the protocol does not expose Max undo boundaries, selection,
  gestures, causality, or semantic intent. The bridge retains at most 128
  observations or 32 MiB globally and reports dropped history explicitly.
- Generated working DSL is an explicit managed-graph representation. It does
  not preserve authoring macros or patch-level metadata that PatchGraph does not
  own.
- Patchline metadata (`midpoints`, `color`, `hidden`, and `disabled`) is not
  managed in protocol version 1, cannot be adopted as managed desired state,
  and is lost if a connection must be recreated.
