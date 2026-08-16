# Test matrix

## Purpose

Maxforge crosses five runtime and persistence boundaries: MCP host, stdio
frontend, detached broker, native `maxforge.sync`, and Max itself. Line coverage
cannot show whether those boundaries survive replacement, restart, or human
editing. This matrix assigns each boundary to CI or to an explicit human test.

Status meanings:

- **CI** — deterministic and required by `.github/workflows/build-max-package.yml`.
- **Human** — requires a real Max host, MCP-host lifecycle, another machine, or
  visual/OS confirmation.
- **Partial** — useful automation exists, but a real-host property remains.

## Coverage by boundary

| ID | Boundary | Status | Current evidence | Human follow-up |
|---|---|---|---|---|
| A01 | DSL parsing, blocks, `for`, `if`, arithmetic, diagnostics | CI | `tests/block.test.ts`, `tests/expander.test.ts`, `tests/compiler.test.ts` | None for language semantics |
| A02 | Built-in/project catalog, known-invalid names, argument-dependent ports | CI / Partial | CI checks catalog structure, reviewed regressions, and argument rules; it does not prove every built-in name exists | H08 proves declared custom objects in Max; H10 audits built-ins against installed Max resources |
| A03 | Patch graph conversion, diff, merge, layout, patch-cord metadata | CI | `tests/patch-graph.test.ts`, `tests/patch-merge.test.ts`, `tests/reconcile.test.ts`, `tests/thispatcher.test.ts` | H02 checks the native Max result |
| A04 | MCP schemas, help, tool responses, target routing | CI | `tests/mcp-server.test.ts`, `tests/mcp-service.test.ts`, `tests/mcp-bridge.test.ts` | H02–H04 check one real MCP host and Max session |
| A05 | Human-edit evidence, review/adopt/reconcile, stale tokens | CI / Partial | `tests/patch-edit-review.test.ts`, `tests/mcp-edit-history-store.test.ts`, `tests/mcp-service.test.ts` | H02 supplies edits through the Max UI rather than synthetic snapshots |
| A06 | State/history persistence, torn records, migration, writer lease | CI / Partial | `tests/mcp-state-store.test.ts`, `tests/mcp-edit-history-store.test.ts`, `tests/process-lease.test.ts` | H04 checks recovery across actual application/client restarts |
| A07 | Broker sharing, idle exit, dead owner, version/config mismatch | CI | `tests/mcp-broker.test.ts`, `tests/mcp-broker-lifecycle.test.ts` | H05 checks the MCP host's reconnect control |
| A08 | Broker replacement and forced restart | CI / Partial | CI checks stale diagnostic refresh, disappearance, compatible replacement, diagnostic-only tools, and old-frontend exit | H05 confirms that the real MCP host exposes full tools only after reconnect |
| A09 | npm tarball contents and executable entrypoints | CI | `npm run test:package` installs a clean tarball, runs `maxforge validate`, and initializes installed `maxforge-mcp` | H09 checks the published registry package rather than the local tarball |
| A10 | Native protocol parsing/serialization | CI / Partial | CTest runs on macOS and Windows in package CI | H01–H03 exercise Max SDK calls and actual patcher mutation |
| A11 | Max package source, help, macOS universal binary, Windows external, release zip | CI / Partial | package verifier plus macOS/Windows build jobs | H09 checks Max search paths, loading, and OS security behavior after download |
| A12 | Documentation links and GitHub Pages assets | CI | `npm run docs:check`, Pages verifier, JavaScript syntax check | Visual browser review only when site presentation changes |
| A13 | Authenticated LAN bind and token rejection | CI / Partial | bridge and entrypoint tests cover bind/token protocol behavior | H07 checks routing/firewall behavior between physical hosts |

## Scenario coverage for stateful editing

| Scenario | Automated assertion | Real-host assertion |
|---|---|---|
| Agent applies to an unchanged patch | plan, acknowledgement, revision, and verification baseline | H02 |
| Human edits after an agent apply | review clusters and structure tokens are derived from synthetic live evidence | H02 uses Max UI edits |
| Agent adopts the human edit, then applies another DSL diff | stale-token and adopted-baseline behavior | H02 verifies that the human edit is preserved |
| Broker dies or is force-restarted | lease recovery and old frontend termination | H04/H05 verify MCP-host recovery |
| Diagnostic frontend outlives a failed/old broker | every status call refreshes; compatible replacement yields `RECONNECT_REQUIRED`; tool list remains diagnostic | H05 reconnects the MCP entry and checks full tools |
| Max closes and reopens a saved patch | bridge disconnect behavior and state rekeying are unit tested | H03/H04 verify native registration and saved-path identity |

## What must not be called automated

The following can be driven by GUI automation on a developer Mac, but they are
not reliable CI gates yet:

- Max window creation, dirty state, save dialogs, and native object placement;
- Max Console severity/color and OS security prompts;
- Codex's MCP-process restart control and user approval prompts;
- Max package discovery when duplicate externals exist in search paths;
- LAN firewall, address selection, and a second machine's route.

Treat an agent-driven local run as **human evidence**, because a person still
provides the application session, permissions, and interpretation.

## Remaining automation candidates

Ranked by expected defect prevention rather than test count:

1. Add a protocol-level fake Max client that runs longer mixed sequences:
   register → inspect → human-edit event → reconcile → apply → disconnect →
   reconnect. Existing tests cover these operations mostly in smaller groups.
2. Run `npm run test:package` on Windows if npm `.cmd` entrypoint failures occur;
   the current CI smoke runs on Ubuntu while native artifacts build on both OSes.
3. Add deterministic fault injection around atomic state-file rename/fsync if a
   real interrupted-write defect appears. Do not mock every filesystem call
   pre-emptively; current corrupt/torn-record tests cover the known failure mode.
4. Build a Max-host integration runner only if Cycling '74 provides a stable,
   headless execution boundary. UI scripting is too flaky to be a merge gate.

## Change policy

- Every process-lifecycle or persistence bug gets a regression test at the
  lowest boundary that reproduces it.
- Every new MCP mutation needs success, stale-target/token, disconnect/timeout,
  and restart-persistence analysis. Not every cell requires a new test when a
  shared invariant already covers it.
- Update this matrix and the [manual checklist](manual-test-checklist.md) when a
  boundary moves between human and CI ownership.
- Passing unit tests do not authorize a release when a changed behavior is
  assigned to a human test below.
