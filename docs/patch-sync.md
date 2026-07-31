# Managed patch synchronization

This document defines the experimental desired-state protocol used to synchronize
a maxforge DSL fragment with a live Max patcher.

## Boundary

The TypeScript library is the compiler and planner. It produces a `PatchPlan`;
it does not mutate Max. The included `maxforge.sync` external validates and
applies the plan through the Max SDK.

```text
DSL -> PatchGraph -> diffPatchGraphs(current, desired) -> PatchPlan -> Max consumer
```

The protocol version is currently `1`.

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

The reserved varname is the ownership marker in protocol version 1. Manually
renaming an object into this namespace explicitly adopts it into the scope.

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

The consumer must reject a plan when `baseRevision` does not match its current
managed revision. A revision is optimistic concurrency control, not rollback.

## Operations

`PatchPlan.operations` is ordered and JSON-serializable:

1. `disconnect` obsolete or replaced connections.
2. `delete` obsolete or structurally changed boxes, deepest patchers first.
3. `create` new or structurally changed boxes, parent patchers first.
4. `set` mutable attributes. Version 1 only emits `patching_rect`.
5. `connect` new or restored connections.

Each operation contains a `targetPath` of parent subpatcher scripting names.
An empty path targets the patcher containing the Max-side consumer.

Object text, class, inlet/outlet shape, comments, and custom attribute changes
are structural in version 1. Such changes recreate the object. Position-only
changes emit `set` and preserve the object instance.

## Consumer requirements

A correct consumer must:

- Validate the protocol version, scope, revision, and all operations before
  mutating the patch.
- Resolve every `targetPath` and managed scripting name before destructive work.
- Apply operations on Max's main thread.
- Reject references outside the active managed scope.
- Update its current revision only after every operation succeeds.
- Keep a pre-apply snapshot if rollback is required.

The Max SDK does not make arbitrary external-driven patcher mutations undoable.
Do not claim transaction safety until snapshot restoration has been implemented
and tested in Max.

## maxforge.sync

Build the native consumer:

```bash
git submodule update --init --recursive
cmake -S . -B build
cmake --build build
```

`maxforge.sync` supports:

- `apply <compact-json>` — validate and apply a serialized `PatchPlan`.
- `validate <compact-json>` — validate without mutation.
- `applydict <name>` — validate and apply a named Max dictionary.
- `inspect [request-id]` — emit a structural snapshot of the containing
  patcher without mutating it.
- `revision` — output the consumer's current revision.
- `@scope <name>` — select the exact managed namespace.
- `@revision_state <hash>` — persisted optimistic concurrency state.

The status outlet also emits machine-readable transport events as
`event <compact-json>`:

- `maxforge.applied` after all operations succeed.
- `maxforge.revision` in response to `revision`; an uninitialized revision is
  encoded as `null`.
- `maxforge.snapshot` in response to `inspect` or a correlated
  `maxforge.inspect.request`.
- `maxforge.error` when parsing, validation, or mutation fails.

These events are intended for a native transport object. Human-readable
`applied`, `revision`, and `error` messages remain available on the same outlet.
Failures are also sent through Max's error API, so they use error severity in
the Max Console rather than appearing as ordinary posts.

The MCP transport sends inspection requests through the existing `apply`
wiring:

```json
{
  "type": "maxforge.inspect.request",
  "requestId": "correlation-id",
  "scope": "voices"
}
```

The snapshot response contains root patcher metadata plus flattened boxes and
connections. `targetPath` identifies nested patchers. Box records include
`runtimeId`, `varName`, `maxclass`, `patchingRect`, `managed`, and `text` when
the box exposes it. Connection records include both endpoint runtime IDs,
varnames, and port indices.

Inspection is structural by design. It does not serialize arbitrary object
attributes or live values: doing so would confuse UI/DSP state changes with
patch edits. Patchline color, hidden state, and midpoints are also omitted.

The first apply is accepted only when the revision state is empty and the
configured scope contains no managed root boxes. After success,
`revision_state` advances to `targetRevision`. It is not advanced when an
operation fails.

The consumer parses and validates all operations before mutation. Validation
simulates create/delete ordering so a plan can create a parent subpatcher and
then target its contents. Mutation occurs synchronously on Max's main thread.

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

- MCP graph state is process-local. An initialized Max scope must be re-seeded
  with accurate `currentDsl` after the MCP process restarts.
- MCP-to-Max transport currently requires the separate native `bbb.agent.hub`
  external.
- A `PatchPlan` is not atomic by itself.
- Runtime/standalone Max support is not guaranteed.
- MCP comparison baselines are process-local and begin only after an
  acknowledged apply. A snapshot can always report current state, but it cannot
  reconstruct edit history that predates the baseline.
- Patchline metadata (`midpoints`, `color`, `hidden`, and `disabled`) is not
  managed in protocol version 1 and is lost if a connection must be recreated.
