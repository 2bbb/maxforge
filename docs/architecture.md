# Architecture

maxforge ships as one repository and one npm package, but it has two product
surfaces:

- an offline DSL toolchain that compiles and decompiles Max patch JSON; and
- an experimental live-control stack that lets an MCP client reconcile a
  complete desired patch with an open Max patcher.

They share a patch domain. They are not one module.

## Dependency direction

```text
DSL parser/compiler ──> DSL PatchGraph adapter ──┐
                                                v
                                  PatchGraph / PatchPlan
                                                ^
live Max snapshot ──> snapshot/reconcile domain ┤
                                                v
                           live patch service / state machine
                                                v
                          MCP tools / WebSocket bridge / Max
```

The rules are:

1. `PatchGraph` and `PatchPlan` are the canonical managed-patch model. They do
   not import the DSL parser, MCP server, or WebSocket bridge.
2. DSL is an input adapter. MCP accepts complete desired DSL, but neither the
   native protocol nor persisted live state stores raw DSL as its canonical
   representation.
3. Snapshot and protocol contracts live outside the concrete WebSocket bridge.
   Reconciliation and persistence must not depend on that bridge.
4. `MaxforgePatchService` coordinates revisions, reconciliation, persistence,
   and transport. DSL compilation and catalog-backed box resolution are
   injected through `PatchGraphAdapter`.
5. Entry points compose concrete implementations. `src/mcp/server.ts` owns the
   `DslPatchAdapter`, state store, WebSocket bridge, and MCP server lifecycle.

## Source boundaries

| Layer | Main files | Responsibility |
|---|---|---|
| DSL frontend | `src/dsl/*`, `src/core/compiler.ts` | Parse and compile `.maxdsl` into Max patch JSON |
| DSL graph adapter | `src/max/dsl-patch-graph.ts` | Convert DSL compiler output into a managed `PatchGraph` |
| Patch domain | `src/max/patch-graph.ts`, `patch-merge.ts`, `patch-protocol.ts`, `patch-snapshot.ts` | Managed graph identity, revisions, plans, snapshots, and pure comparisons |
| Live-control application | `src/mcp/service.ts`, `reconcile.ts`, `state-store.ts`, `edit-history-store.ts` | Coordinate desired state, atomic recovery state, and append-only edit evidence |
| Adapters | `src/mcp/dsl-patch-adapter.ts`, `bridge.ts`, `mcp-server.ts` | Catalog resolution, WebSocket transport, and agent-facing MCP tools |
| Max host | `source/projects/maxforge.sync/` | Validate and apply protocol operations through the Max SDK |

## Public packaging

The root `maxforge` export exposes the offline compiler and patch-domain APIs.
`maxforge/mcp` exposes live-control APIs. Keeping one package avoids duplicate
versioning while those APIs share protocol and graph versions. A package or
repository split is justified only if those release cycles become independent;
it is not a substitute for the dependency rules above.

## Extension rules

- Add another desired-state language as a new adapter that produces
  `PatchGraph`; do not add its syntax to the patch domain.
- Add another transport by implementing `PatchPlanTransport`; do not teach
  reconciliation about transport messages.
- Change protocol fields in `patch-protocol.ts` and the native external together.
- Put pure graph, snapshot, diff, and merge behavior in the patch domain rather
  than MCP tool handlers or the WebSocket bridge.
- Keep MCP tools as validation and presentation wrappers around application
  services. They must not become a second compiler or reconciliation engine.
