# Managed patch synchronization

This document defines the experimental desired-state protocol used to synchronize
a maxforge DSL fragment with a live Max patcher.

## Boundary

The TypeScript library is the compiler and planner. It produces a `PatchPlan`;
it does not mutate Max. A Max-side consumer such as `maxforge.sync` is responsible
for validating and applying the plan through the Max SDK.

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

## Current limitations

- There is no network transport or MCP server in this package yet.
- There is no Max external consumer yet.
- A `PatchPlan` is not atomic by itself.
- Runtime/standalone Max support is not guaranteed.
- Manual edits to managed objects require a fresh snapshot before the next diff.
- Patchline metadata (`midpoints`, `color`, `hidden`, and `disabled`) is not
  managed in protocol version 1 and is lost if a connection must be recreated.
