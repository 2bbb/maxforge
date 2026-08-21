# maxforge MCP control

`maxforge-mcp` lets an MCP-capable agent replace a scope-owned Max patch graph
from complete desired DSL. It does not run an agent or JavaScript inside Max.

## Architecture

```text
MCP client A ---- stdio ---- maxforge-mcp frontend A --+
MCP client B ---- stdio ---- maxforge-mcp frontend B --+-- local broker protocol
                                                       |
detached project broker (Node.js 20+; one state/history owner)
  | ws://127.0.0.1:8766 by default
  | authenticated LAN WebSocket when explicitly enabled
one maxforge.sync per registered patch (native Max external)
  | Max SDK
containing patcher
```

The boundary is intentional:

- MCP, DSL compilation, diffing, and session state belong in Node.js.
- Per-session `maxforge-mcp` processes are thin stdio frontends. The first
  frontend starts the detached broker; later frontends attach to the same
  project broker.
- The broker, not a frontend, owns the WebSocket listener, desired-state file,
  edit-history lease, catalog runtime, and live Max registrations.
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
node dist/mcp/bin.js
```

Published-package MCP configuration:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": [
        "-y",
        "--package=maxforge@X.Y.Z",
        "maxforge-mcp"
      ]
    }
  }
}
```

Replace `X.Y.Z` with one exact release; do not keep a live configuration on
npm's moving `latest` dist-tag. The npm package installs the `maxforge-mcp`
Node.js executable. It does not itself install the native `maxforge.sync`
external into Max. A working live setup needs both processes and at least one
open, registered Max patch.

Environment variables:

| Name | Default | Meaning |
|---|---:|---|
| `MAXFORGE_WS_TOKEN` | unset | Shared LAN token; setting it enables authenticated LAN publication |
| `MAXFORGE_WS_HOST` | conditional | `127.0.0.1` without a token, `0.0.0.0` with a token |
| `MAXFORGE_WS_PORT` | `8766` | WebSocket port used by `maxforge.sync` |
| `MAXFORGE_APPLY_TIMEOUT_MS` | `5000` | Max apply, inspection, or patch creation response timeout |
| `MAXFORGE_CONFIG` | unset | Explicit project config; no MCP working-directory discovery |
| `MAXFORGE_STATE_FILE` | project-scoped with `project.id`, otherwise `~/.maxforge/mcp-state-<port>-v2.json` | Atomic graph/source/baseline state file; `off` disables restart recovery |
| `MAXFORGE_EDIT_HISTORY` | enabled only with `project.id` | Set to `off` to disable persistent edit evidence |
| `MAXFORGE_EDIT_HISTORY_DIR` | `~/.maxforge/projects/<project.id>/edit-history-v1` | Override the project edit-history directory |
| `MAXFORGE_EDIT_HISTORY_MAX_BYTES` | `268435456` | Maximum retained NDJSON bytes |
| `MAXFORGE_EDIT_HISTORY_MAX_AGE_DAYS` | `7` | Maximum retained chunk age in days |
| `MAXFORGE_BROKER_PORT` | deterministic project-local port | Override the loopback broker endpoint; mainly for collision recovery and tests |
| `MAXFORGE_BROKER_DIR` | `~/.maxforge/brokers` | Directory containing the project-owner lease; every frontend for one project must use the same value |
| `MAXFORGE_BROKER_IDLE_MS` | `300000` | Stop the broker after this many milliseconds with zero MCP clients, zero Max clients, and zero pending operations |
| `MAXFORGE_BROKER_START_TIMEOUT_MS` | `5000` | How long a stdio frontend waits for a starting broker |

### Broker lifecycle and upgrades

The broker is independent of the frontend that first started it. Closing that
MCP session disconnects only its stdio frontend. The broker continues while
another MCP frontend or any `maxforge.sync` client remains connected. It exits
only after all three counts are zero for `MAXFORGE_BROKER_IDLE_MS`:

- MCP frontend connections;
- Max WebSocket clients;
- pending inspect/apply/create/open/save/close operations.

Inspect or manage it with the package version you intend to run:

```bash
npx -y --package=maxforge@X.Y.Z maxforge broker status --config /absolute/path/maxforge.config.json
npx -y --package=maxforge@X.Y.Z maxforge broker restart --config /absolute/path/maxforge.config.json
```

`stop` and `restart` refuse a broker with connected MCP or Max clients. Close
those clients first for a non-disruptive package upgrade. `--force` explicitly
disconnects connected clients, but still refuses while a native operation is
pending. Existing MCP sessions must reconnect after a forced restart; open
`maxforge.sync` objects reconnect through their native retry behavior. MCP
attachment requires the frontend and broker to report the same Maxforge package
version. A mismatched frontend still initializes a diagnostic MCP server, but
`maxforge_status` reports `VERSION_MISMATCH` and the running broker status
instead of exposing mutation tools. Each diagnostic `maxforge_status` call
rechecks the live broker rather than retaining the startup failure. After a
compatible replacement appears, it reports `RECONNECT_REQUIRED` with the new
broker PID and version. Reconnect that MCP frontend to negotiate the full tool
set; the outer Agent host does not need to be restarted. Use `broker status` and
then an explicit `broker restart` with the intended package version; lifecycle
commands remain available across package-version mismatch so an old broker is
not stranded during upgrades.

When custom externals or reusable abstractions appear in desired DSL, set
`MAXFORGE_CONFIG` in the MCP client process configuration. Prefer an absolute
path because a client's launch directory is not a reliable project root:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": ["-y", "--package=maxforge@X.Y.Z", "maxforge-mcp"],
      "env": {
        "MAXFORGE_CONFIG": "/projects/show/maxforge.config.json"
      }
    }
  }
}
```

The configured catalog is loaded at server startup. After editing its files,
call `maxforge_reload_catalog` and verify the replacement digest with
`maxforge_catalog`; a broker restart is unnecessary. A valid declaration is
not a runtime availability check: the Max machine still needs the corresponding
external binary or abstraction search path. See
[`object-catalog.md`](object-catalog.md#project-object-catalogs).
Hot reload may change object declarations or the display name, but it rejects a
different `project.id`; switching persistence namespace requires a broker restart.

Add a stable `project.id` even when the project has no custom objects if edit
history must survive broker restarts. Without it, managed state still uses the
per-port fallback, but edit-history persistence is intentionally disabled;
maxforge does not invent a collision-prone `default` project. `maxforge_status`
reports the loaded project and edit-history persistence health.

With no token, non-loopback bind addresses are rejected and existing local
setups remain unauthenticated on `127.0.0.1`. Set a human-chosen token to bind
to all interfaces:

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": ["-y", "--package=maxforge@X.Y.Z", "maxforge-mcp"],
      "env": { "MAXFORGE_WS_TOKEN": "studio-session_1" }
    }
  }
}
```

On the Max machine, point `maxforge.sync` at the LAN address of the machine
running the broker and use the same token:

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
npx skills add bbb-max-externals/maxforge --skill maxforge-mcp
```

Use the separate `maxforge` skill for offline DSL authoring and `.maxpat`
compilation. A skill supplies instructions only: it does not install or start
`maxforge-mcp`, and it does not install the native external.

The compact live sequence is fixed:

1. use `maxforge_help` only when the installed skill/tool contract is missing,
   unfamiliar, or in recovery; do not add this round trip to every normal edit
2. `maxforge_status` when connection/process state is uncertain
3. `maxforge_catalog` before using a custom external or abstraction
4. `maxforge_list_patches`
5. require the selected target's `versionCompatible` to be `true`; compare its
   `externalVersion` with `bridge.expectedExternalVersion` when diagnosing a
   mismatch
6. create a blank target with `maxforge_create_patch`, or open an existing file
   with `maxforge_open_patch`, only when a separate target is required
7. `maxforge_inspect_patch` with summary detail; request full detail only when
   complete surrounding topology is needed
8. when edit order matters, call `maxforge_get_live_edit_history` before
   interpreting the current snapshot; check `supported`, `droppedEvents`, and
   every entry's `comparisonBasis`
9. if live changes exist, call `maxforge_review_live_changes`; its default
   summary omits the full snapshot, raw rows, duplicate signals, and proposed
   DSL. Request `detail: "full"` only for exact before/after evidence
10. either adopt accepted managed edits with the exact returned structure token,
    or prepare the concrete next state with `manualChanges: "merge"`
11. call `maxforge_prepare_change` with complete `desiredDsl` once, or use the
    latest `sourceRef` as `baseSourceRef` plus small half-open line `edits`
12. require `canApply: true`; review counts, every delete/disconnect,
    replacement, warning, and conflict. Bulk create/connect/rollback operations
    stay behind the returned one-time receipt
13. call `maxforge_apply_prepared_change` with only `receiptId`; never resend DSL
    and never retry the consumed receipt after an ambiguous result
14. retain returned `sourceRef`; fetch matching snippets for local edits and full
    source only for broad rewrites/recovery. Verify acknowledgement and
    post-apply revision, then save only when persistence is intended

Do not collapse this into a direct apply. Titles are not identities, DSL is not
an imperative edit, and a timeout is not proof that Max remained unchanged.

## Tools

### `maxforge_help`

Returns structured agent instructions for one of the four topics above. It does
not require Max to be running and is safe to call before any target registers.
It is fallback documentation, not a mandatory normal-path call. Call `recovery`
after an ambiguous failure; do not retry a consumed receipt.

### `maxforge_status`

Reports:

- broker lifecycle state, package version, PID, idle timeout, connected MCP
  frontend count, connected Max count, and pending native operation count;
- raw connected Max client count;
- the MCP runtime version expected from native externals;
- every registered patch's `patcherId`, scope, controller capability, path,
  revision, loaded `externalVersion`, and `versionCompatible` result;
- the last revision received for each `patcherId:scope` target;
- graph revisions remembered by the current broker runtime;
- targets with a post-apply structural inspection baseline;
- effective object-catalog digest, configured source files, and built-in,
  custom, and abstraction counts.

Raw WebSocket connections are not operation targets. A client becomes
addressable only after `maxforge.sync` sends `maxforge.registered`. Apply and
inspection route to the explicit `patcherId`; multiple registered patches are
therefore not ambiguous.

### `maxforge_catalog`

Reads the compiler catalog loaded by the project broker. It does not require Max
to be running and never mutates a patch.

Arguments:

- `query` — optional case-insensitive substring filter;
- `includeBuiltins` — include the bundled database; defaults to `false`, so an
  unfiltered call reports project declarations only;
- `limit` — result limit from 1 to 200, default 50.

Each result identifies the object as built-in, external, or abstraction and
reports serialization class, port metadata, dynamic/argument-rule status,
source file, and `paths`. The `paths` array is empty for built-ins and custom
externals without declared package artifacts.
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
Before mutation, require `versionCompatible: true`. The comparison is exact
against `maxforge_status.bridge.expectedExternalVersion`.

`externalVersion` is compiled into the `maxforge.sync` binary that registered
with the bridge. This is stronger than searching from the patch's `filepath`:
Max resolves externals through its search paths and can load a stale duplicate
from somewhere else. On mismatch, the `maxforge-mcp` skill downloads only the
exact tag's `maxforge-vX.Y.Z.zip` and `.sha256`, validates the complete package
and embedded version, backs up the old package outside Max search paths, and
replaces the selected package root while Max is closed. It never falls back to
a moving latest artifact or overwrites multiple candidate copies by guessing.
After replacement, restart Max, reopen the patch, and list it again. Merely
placing a binary beside a `.maxpat` does not prove that Max loaded that copy.

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
- `detail` — `summary` by default; `full` includes the complete snapshot.

Both detail levels include revision, structure token, patch metadata, total box
and connection counts, exact changes since the last baseline, and separate
managed/unmanaged counts. `detail: "full"` additionally includes:

- patcher title, file path, dirty/locked/presentation state;
- every box's nested path, runtime ID, scripting name, Max class, text/comment,
  position, bounded serializable attributes, and maxforge ownership;
- source/destination endpoints and exposed serializable attributes for every
  patch cord;
- exact box and connection changes since the last acknowledged apply;
- separate managed and unmanaged change counts.

The comparison baseline is captured immediately after a successful apply or
adoption. Inspection is read-only and does not advance that baseline. Before
the first baseline, or when persistence was disabled/unavailable,
`comparisonAvailable` is `false`: request `detail: "full"` when the complete live
state is required, but the server still cannot honestly claim which prior action
caused it.

### `maxforge_get_live_edit_history`

Returns ordered structural evidence observed by a connected native
`maxforge.sync`. This is the tool to call when the difference between “the human
added A, then moved B” and one final combined snapshot matters.

Arguments:

- `patcherId` — registered target patch;
- `scope` — exact advertised scope;
- `afterSequence` — optional exclusive cursor for polling only newer entries.

Each observation includes a bridge-assigned monotonic `sequence`, timestamp,
native `structureToken`, notification cause categories, raw structural
`changes`, and the same evidence-only `review` model used for live-change
reasoning. `comparisonBasis` states whether changes were computed against the
exact registration-session baseline, the previous observation in that same
session, or incomplete/missing evidence. `instanceId` identifies one native
`maxforge.sync` object lifetime; server-assigned `sessionId` changes on every
accepted registration or reconnect.

Read the honesty fields before using chronology:

- `supported: false` means the connected native external did not advertise the
  observation capability;
- `droppedEvents > 0` means in-memory retention removed older observations;
- `comparisonBasis: incomplete_after_drop` means the first retained difference
  cannot be treated as a complete transition;
- `latestSequence` is a polling cursor, not a Max revision;
- `observedAt` is snapshot-arrival time, not the timestamp of an individual Max
  edit;
- `persistence` reports whether project-scoped disk history is active, its
  location, and read/write warnings;
- `patchMetadata` retains registration and save-path observations. A saved
  `filepath` is a locator for reopening and move/Save As detection, not a stable
  identity.

The native external debounces notifications for 75 ms, snapshots the root and
nested patchers, excludes agent-authored plan application, and drops events when
the structure token did not change. The bridge retains at most 128 observations
or 32 MiB globally in memory. With `project.id`, append-only NDJSON chunks
restore retained evidence after a broker restart; reconnect starts a new session
with a fresh baseline rather than comparing across that boundary. Disk
retention defaults to seven days and 256 MiB. Multiple edits inside one debounce
window collapse into one observation; notification categories can be `unknown`; Max undo steps,
selection, gesture boundaries, causality, and human intent are not available.
Use `maxforge_inspect_patch` as current truth and
`maxforge_review_live_changes`/adoption/reconciliation for baseline ownership.

### `maxforge_get_patch_history_identity`

Reads the project-scoped identity ledger without requiring the historical patch
to be connected. The result includes the requested identity, current canonical
identity, known/forgotten state, aliases, and every explicit decision relevant
to that identity group. This is the inspection step for a saved-path warning;
the path itself is not evidence that two patch identities are equal.

Persistent history and a configured `project.id` are required. This tool does
not inspect or mutate live Max routing.

### `maxforge_resolve_patch_history_identity`

Appends one explicit decision to `identity-resolutions-v1.ndjson`:

- `rekey` moves one known, closed source history to an unused `targetPatcherId`;
- `merge` combines one known, closed source history with an already known
  target after the human confirms they represent the same logical patch;
- `forget` excludes a known, closed identity group from Agent-facing history.

Pass the exact `expectedProjectId`, source ID, shared `scope`, a target ID for
`rekey`/`merge`, and a concrete human-confirmed `reason`. The source group must
be disconnected. Resolutions cannot cross scopes, target an alias, create a
cycle, or infer identity from a filepath.

This operation deliberately does **not** rewrite a live `maxforge.sync`
`patcherId`, move or rewrite original observation chunks, or change Max files.
`forget` is a logical visibility decision and returns
`physicalDataErased: false`; retained NDJSON remains until normal retention.

### `maxforge_erase_project_history`

Deletes retained edit evidence instead of hiding it. Before calling it:

1. the human must explicitly request deletion;
2. close every Max patch containing `maxforge.sync` for the project;
3. verify `maxforge_status.bridge.connectedClients` is zero;
4. pass the exact `expectedProjectId` and confirmation text
   `ERASE PROJECT HISTORY <project.id>`.

The operation deletes maxforge-owned session chunks and
`identity-resolutions-v1.ndjson`, then clears retained observations, drop
counters, and the next history sequence from MCP memory. It preserves unrelated
files in a custom history directory. The result includes `filesDeleted`,
`bytesDeleted`, and `retainedObservationsCleared`.

This is deliberately narrower than “erase the project.” It does not delete Max
patches, DSL sources, catalog config, npm files, or `mcp-state-v2.json`. It also
returns `secureOverwriteGuaranteed: false`; filesystem deletion does not prove
that SSD blocks, backups, or filesystem snapshots were overwritten.

### Single-writer lease

Persistent edit history supports one broker writer per history directory. A
deterministic loopback ownership endpoint is bound after the local control
endpoint but before bridge or persistence startup, so changing the local broker
port cannot create another state writer. Its holder then acquires the
project-owner lease and
atomically creates `writer-v1.lock`. Clean shutdown removes both leases only
when their random tokens still match.

After an abnormal broker termination, the replacement validates the lease,
checks that its recorded process is dead, atomically quarantines the stale file,
and creates a new tokenized lease. It never displaces a live lease, a malformed
lease, or a lease whose owner cannot be proven dead. Two concurrent recovery
attempts are serialized by a deterministic loopback ownership endpoint that the
OS releases when its process exits; the stale lease is revalidated by token
immediately before quarantine. This is crash recovery, not multi-writer
synchronization. The ownership endpoint is independent of
`MAXFORGE_BROKER_PORT`, so changing the stdio broker endpoint cannot create a
second project writer.

### `maxforge_inspect_pending_apply`

Reads a persisted in-flight apply without invoking the normal base/target
auto-resolution path. Use it when `maxforge_status.state.pendingScopes` contains
the target and Max reports a third revision.

The result retains the active pending identities (`baseRevision`,
`targetRevision`, and `intentRevision`), their recoverable DSL sources, the
current `liveRevision`, `liveState`, exact `structureToken`, snapshot, and
baseline-relative edit evidence. If a recovery transition itself lost its
acknowledgement, `supersededApply` additionally retains the original unresolved
base, target, intent, and canonical target/intent DSL. It is read-only and does
not clear the pending record. A revision hash alone is not enough to recover a
graph; retain or locate the complete DSL that produced the third live revision.

### `maxforge_recover_pending_apply`

Explicitly rebases an ambiguous pending apply onto inspected live state. The
only action is `rebase_live`. It requires:

- the same `patcherId` and `scope`;
- `expectedLiveRevision` and `expectedStructureToken` copied from the immediately
  preceding pending inspection;
- trusted complete `currentDsl` whose compiled revision exactly equals that live
  revision.

Recovery re-inspects Max, rejects either stale guard, reconstructs the actual
managed snapshot, and verifies lossless DSL serialization before replacing the
baseline. If snapshot-derived managed state requires a revision change, Maxforge
durably records a recovery-in-progress transition before sending a token-bound
zero-operation revision transition. If Max applies it but its acknowledgement is
lost, the next inspection exposes the active recovery DSL plus the abandoned
apply under `supersededApply`; ordinary prepare/review calls stay
blocked until explicit recovery finishes. Do not use guessed DSL or delete the
state file as a substitute.

### `maxforge_review_live_changes`

Inspects the target and converts changes since the comparison baseline into a
structured, neutral review. The default `detail: "summary"` includes counts,
managed/unmanaged identities, `canAdopt`, conflicts, exact `structureToken`,
edit clusters, and interpretation guidance. It deliberately omits the complete
snapshot, raw change rows, duplicate top-level signals, and proposed complete
DSL. `detail: "full"` adds those fields when exact before/after values or a
lossless adoption preview is actually required.

`review.editClusters` correlates raw changes when they occur in the same patcher
path and share a managed object ID or unmanaged runtime ID. Each cluster carries:

- `changeIndexes` that identify raw rows available in full detail;
- separate managed and unmanaged identities;
- all observed runtime IDs, kept separate from stable managed identities;
- combined `signalKinds` describing the observed effects;
- `interpretationRisks` for mixed effects, unmanaged context, or an ownership
  boundary change;
- a neutral summary.

`review.interpretationGuidance.mode` is always `evidence_only`.
`clarificationRecommendedFor` lists every cluster with an interpretation risk,
including mixed effects, unmanaged context, and ownership changes. It is not a
command to ask every time: ask only when competing interpretations would change
the next patch mutation. Independent edits remain separate clusters even when
they share the same signal kind and patcher path.

This tool reports **what changed**, not **why it changed**. A moved box may be a
cosmetic cleanup, a grouping hint, or an accidental drag. The agent should use
the conversation and surrounding graph to infer likely intent, state uncertainty
when more than one explanation remains, and ask the human only when that
ambiguity changes the next action.

Unmanaged additions are useful context but are not silently claimed by the
managed scope. A newly introduced reserved managed identity, ownership conflict,
or unsupported structural change makes `canAdopt` false. Protocol v1 does not
represent patch-cord attributes in `PatchGraph`, so a managed cord metadata edit
is reported but cannot be adopted as desired state.

### `maxforge_adopt_live_changes`

Accepts the exact reviewed live managed structure as the new acknowledged and
agent-intent baseline.

Arguments:

- `patcherId` — registered target patch;
- `scope` — target managed namespace;
- `expectedStructureToken` — token returned by the immediately preceding
  `maxforge_review_live_changes` call.

Adoption re-inspects Max and rejects a stale token. When safe, it reconstructs
the managed graph from the live snapshot and sends a zero-operation plan whose
only state transition is the native revision. It does not replay moves, text
changes, deletions, or rewiring that already happened in Max. A zero-operation
acknowledgement is therefore valid only through this token-bound adoption path;
it is not a general way to bypass revision validation.

After adoption, retain the returned `sourceRef`. It identifies complete working
DSL generated from the adopted graph and verified to recompile to the same
revision. Query only the source regions needed for the next edit through
`maxforge_get_working_source`; do not inject the full source into agent context
unless a broad rewrite or recovery requires it. Explicit
`at(x, y, width, height)` preserves human resize edits.

Adoption has no reliable source-level representation of edits made directly in
Max. Its broker-retained working source is therefore canonical explicit managed
state rather than a reproduction of the original authoring text: `for`/`if` macros are expanded,
and patch-level title/description/size are omitted because protocol v1 does not
manage those fields. Ordinary no-drift apply does preserve the submitted authored
DSL exactly. Use the returned `sourceRef` as the revision-safe handle.

Use adoption when the human's current managed patch should become the baseline
before the agent plans the next step. When the agent already has a concrete next
state, use `maxforge_prepare_change` with `manualChanges: "merge"` instead.

### `maxforge_prepare_change`

Prepares one complete desired-state change without mutating Max. The broker keeps
the full ordered `PatchPlan` and rollback data behind a one-time `receiptId`; the
response returns only:

- operation totals split by disconnect/delete/create/set/connect;
- every destructive disconnect/delete operation;
- identities that are structurally replaced;
- warnings, merge conflicts, source metadata, and the inspected structure token.

This deliberately prevents large generated patches from flooding agent context
with thousands of create/connect/rollback rows. Preparation accepts exactly one
source mode:

1. `desiredDsl` for a new source or broad rewrite. It is complete desired state,
   not an imperative fragment.
2. `baseSourceRef` plus `edits` for a local change. Each edit is a 1-based,
   half-open `[startLine, endLine)` range against the original retained source;
   equal boundaries insert. Ranges must not overlap. The broker reconstructs and
   compiles the complete desired DSL, and rejects a stale source reference.

Use `maxforge_get_working_source` with `detail: "matches"` to locate semantic DSL
names or text before constructing local edits. Requesting `detail: "full"` for
every edit defeats this optimization.

Pass `expectedStructureToken` from the latest inspection/review when available.
Otherwise preparation performs a fresh inspection. In both cases the retained
plan carries that token, and `maxforge.sync` recomputes it immediately before
native mutation. Any intervening box or cord edit fails closed.

`manualChanges` defaults to `"reject"`. Set it to `"merge"` only after reviewing
managed live edits. Preparation then performs a read-only three-way merge of:

1. previous agent intent;
2. current live Max structure;
3. the next complete desired state.

A live edit is retained when desired state did not change the same field, and a
desired edit is retained when Max did not change it. Same-field changes,
change-vs-delete, ownership ambiguity, unrepresentable graph state, and unmanaged
cord destruction remain explicit conflicts. `canApply: false` has no receipt and
must never be converted into an overwrite.

When a previous merge reports `workingDslRequiredAsCurrent: true`, use its
`sourceRef` as `currentSourceRef` for inline `desiredDsl`, or as `baseSourceRef`
for source edits. Do not resend or reconstruct the complete aligned source.

Receipts are bound to the active catalog digest, patcher/scope, managed and live
base revisions, and native structure token. They are process-local, one-time,
and bounded to the latest 64 preparations. They do not survive broker restart.
Preparing does not reserve the patch; a later human or agent edit makes the
receipt stale.

### `maxforge_apply_prepared_change`

Consumes one `receiptId`, sends its retained plan, and waits for exact native
revision acknowledgement. It does not accept DSL and does not recompile.
Consumption happens before native mutation, so the tool is intentionally
non-idempotent: never retry the same receipt after rejection, timeout, disconnect,
or warning. Inspect current state and prepare a new receipt.

Success requires `acknowledgement.revision === targetRevision`. After
acknowledgement, the service captures a verification snapshot and persists the
new graph/source state. `baselineCaptured: false` means mutation already
succeeded but follow-up inspection failed; it is not permission to repeat apply.
`statePersisted: false` likewise requires diagnosis rather than replay.

The compact result contains operation count, acknowledgement, verification,
source reference/size, warnings, persistence state, and timing stages. It does
not return the full plan, rollback operations, or working DSL. Use timings to
separate compilation/preflight, persistence, native round trip, and post-apply
inspection instead of blaming the agent generically.

Ordinary no-merge preparation preserves authored `for`/`if` source in broker
state. Adoption and merge may retain canonical explicit graph-derived DSL because
direct Max edits cannot be mapped safely back into source macros. Keep the
returned `sourceRef`. When `workingDslRequiredAsCurrent` is true, use that ref in
the next preparation until a successful apply realigns intent state.

Standalone unmanaged edits remain outside the managed graph. A cord between an
unmanaged box and a managed box is preserved while that managed box remains in
place. Merge preparation rejects a desired deletion or structural recreation
that would destroy such a cord.

### `maxforge_get_working_source`

Reads the exact revision-aligned source retained for one `patcherId`/`scope`.
Pass the latest `sourceRef` to reject stale reads. Detail modes are:

- `metadata` (default): source hash, character count, and line count only;
- `matches`: bounded snippets around up to 20 exact names/text fragments, with
  half-open source line boundaries suitable for subsequent edits;
- `full`: complete source, reserved for broad rewrites or recovery.

This tool is the source cache boundary. Normal status, adoption, prepare, and
apply responses return references rather than duplicating complete DSL through
agent context.

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

Prepare a complete desired state once:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated",
  "desiredDsl": "patch \"Generated\"\nbutton_0 = button at(40, 80)\nvalue_0 = number at(80, 80)\nbutton_0 -> value_0"
}
```

If inspection reported accepted managed edits, add merge mode to that prepare
request and require `canApply: true`:

```json
{ "manualChanges": "merge", "expectedStructureToken": "<review token>" }
```

To accept the current human edits before authoring the next DSL, review and
adopt instead:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated"
}
```

Pass the returned token without modification:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated",
  "expectedStructureToken": "<token from maxforge_review_live_changes>"
}
```

On adoption success, retain returned `sourceRef`. Locate only the next edit area:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated",
  "sourceRef": "<sourceRef from adoption/apply>",
  "detail": "matches",
  "queries": ["button_0", "value_0"],
  "contextLines": 1
}
```

Prepare a local insertion without resending complete source. Line ranges are
1-based and half-open; equal boundaries insert:

```json
{
  "patcherId": "generated_patch",
  "scope": "generated",
  "baseSourceRef": "<same sourceRef>",
  "edits": [{
    "startLine": 5,
    "endLine": 5,
    "replacement": "status = comment Ready at(40, 140)"
  }]
}
```

Review compact operation counts, all destructive operations, replacements,
warnings, and conflicts. Apply only the receipt returned by a successful
prepare:

```json
{ "receiptId": "<receiptId from maxforge_prepare_change>" }
```

A successful `maxforge_apply_prepared_change` result has this top-level shape:

```json
{
  "receiptId": "<one-time receipt UUID>",
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
  "verification": {
    "revision": "<same value as targetRevision>",
    "structureToken": "<16 lowercase hex characters>",
    "boxCount": 12,
    "connectionCount": 8
  },
  "sourceRef": "<64 lowercase hex characters>",
  "sourceCharacters": 214,
  "workingDslRequiredAsCurrent": false,
  "manualChangesMerged": 0,
  "warnings": []
}
```

Treat success as all of the following:

- the tool result is not an MCP error;
- `acknowledgement.revision` equals `targetRevision`;
- the acknowledgement operation count matches `operationCount`;
- `verification.revision` equals `targetRevision`.

If `baselineCaptured` is `false`, the acknowledged apply still succeeded. Read
`baselineWarning`, inspect explicitly, and do not repeat the apply merely to
obtain a comparison baseline. The receipt was already consumed regardless of
success or failure; any further attempt requires a fresh inspection/prepare.

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
`project.id` under `~/.maxforge/projects/` when configured, and otherwise by
WebSocket port under `~/.maxforge`. Set an absolute `MAXFORGE_STATE_FILE` when an
MCP client needs an explicit location.

When the current `mcp-state-v2.json` is absent, the default project- or
port-scoped store checks for its corresponding `mcp-state-v1.json`. Every
persisted graph, including pending and superseded apply graphs, must serialize
back to DSL without revision loss; Maxforge then writes v2 atomically and keeps
the v1 file as recovery evidence. Invalid or unrepresentable v1 state fails
startup with the source and destination paths instead of silently starting with
empty state. An explicit `MAXFORGE_STATE_FILE` is never paired with a guessed
legacy filename; migrate that custom file deliberately.

Live-edit evidence uses a separate append-only NDJSON journal because the
atomic state document is not an event log. Each session header stores project,
patcher/scope, native instance, MCP session, title/filename/filepath, and the
exact registration baseline. Save events append updated path metadata. Path is
useful for locating a saved patch, but `project.id + patcherId + scope` remains
the durable logical identity; `instanceId + sessionId` bounds runtime evidence.
Explicit history identity decisions are stored separately in
`identity-resolutions-v1.ndjson`, so evidence chunks remain append-only and
auditable. Rekey/merge affect lookup only; logical forget does not claim secure
deletion.
`maxforge_erase_project_history` is the explicit destructive boundary for that
journal and ledger. It requires zero connected Max clients and exact project
confirmation, clears the retained in-memory copy, and does not claim secure
overwrite or delete the separate desired-state document.
The active bridge keeps `writer-v1.lock` while performing this deletion, so the
history directory can remain present until clean shutdown. The lease prevents
another process from racing sequence allocation or identity decisions; it is
not a multi-writer merge protocol.

Before sending a plan, Maxforge writes an in-flight record containing both base
and target revisions. If acknowledgement is lost, the next process waits for the
same patch to reconnect and accepts only those two outcomes: base means no
mutation was committed; target means the acknowledged graph is promoted. Any
third revision is reported as ambiguous rather than guessed. Inspect it with
`maxforge_inspect_pending_apply`; if complete source for that live revision is
available, use `maxforge_recover_pending_apply` with the exact returned revision
and structure token.

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
| `maxforge_status.broker.state` is `unavailable` | Broker runtime could not acquire its configured WebSocket port, state, or history ownership | Read the structured broker error; stop the conflicting legacy process or correct the project settings, then run `maxforge broker restart` |
| `maxforge_status.broker.code` is `VERSION_MISMATCH` | The stdio frontend package version differs from the detached broker | Inspect `brokerStatus`, close active clients, then run `maxforge broker restart` using the intended package version |
| `maxforge_status.broker.code` is `RECONNECT_REQUIRED` | A diagnostic frontend found a compatible replacement broker, but its startup tool set remains diagnostic-only | Reconnect this MCP server entry so it initializes against the replacement broker; do not restart the outer Agent host |
| A patch reports `versionCompatible: false` | The loaded `maxforge.sync` version is missing or differs from the MCP/broker package | Do not mutate. Install the matching release external in the intended Max package or project search path, remove stale duplicates, restart Max, reopen the patch, and list it again |
| Broker command reports `BUSY` | MCP clients, Max clients, or native operations are still active | Close clients and retry; use `--force` only to disconnect clients, never to interrupt a pending operation |
| Broker endpoint configuration mismatch | Two frontends use the same project identity with different runtime paths, bridge options, or tokens | Make their `MAXFORGE_*` settings identical, or stop the old broker before changing configuration |
| Patch creation reports no controller | No registered patch has `controller: true` | Open the distributed controller patch and list patches again |
| Patch creation reports multiple controllers | More than one controller patch is open | Leave exactly one controller registered before creating a patch |
| Duplicate `patcherId` | Two live patches advertise the same transport identity | Change one `@patcher_id`; titles are irrelevant |
| Process has no graph state for an initialized revision | Persistence was disabled, removed, or pointed at another file | Restore the matching state file or pass the exact previous complete DSL as `currentDsl` once |
| Pending scope appears in status | Apply acknowledgement was lost | Reconnect that exact patch; Maxforge resolves the recorded base or target revision automatically |
| Pending apply reports a third live revision | A different valid patch revision replaced both recorded outcomes | Call `maxforge_inspect_pending_apply`; rebase only with exact trusted `currentDsl`, `liveRevision`, and `structureToken` via `maxforge_recover_pending_apply` |
| Current DSL revision does not match Max | `currentDsl`, scope, or target is wrong | Stop; recover the exact prior DSL instead of forcing empty state |
| Managed manual changes block ordinary prepare | `manualChanges` defaults to `reject` | Review the live changes, then prepare the concrete next state with `manualChanges: "merge"`; apply only the returned receipt when `canApply` is true |
| Reconciliation reports conflicts | Both sides changed the same field, one changed a box the other deleted, a new reserved identity appeared, or a desired replacement would destroy an unmanaged cord | Resolve the listed conflict explicitly; do not force or retry the apply |
| Prepared receipt is missing or consumed | It was applied, rejected, evicted after 64 newer receipts, or the broker restarted | Inspect current state and prepare again; never recreate or retry the old receipt |
| Apply times out or transport disconnects | Acknowledgement is missing; Max may be unchanged, applied, or partially mutated, and the receipt is consumed | Do not retry; call status and inspect before preparing a new change |
| `baselineCaptured: false` | Max acknowledged apply but the follow-up snapshot failed | Treat apply as successful, inspect explicitly, and do not repeat solely for baseline capture |
| `comparisonAvailable: false` | No persisted comparison baseline is available | Use the full snapshot; do not invent historical changes |

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
- Protocol v1 is not transactional. Generated plans include reverse operations
  and the native external attempts them after a runtime failure, but recreated
  runtime IDs, opaque object state, and cords to unmanaged boxes are not
  guaranteed to survive. The revision is not advanced; inspect before retrying.
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
  reported as `managed_box_added`, not silently adopted. Reconciliation accepts
  it only when complete desired DSL explicitly defines the exact live box and
  all managed cords involving it; otherwise remove the reserved scripting name
  or resolve the reported mismatch.
- Inspection and apply are separate requests, but MCP apply plans bind them with
  `baseStructureToken`. A human edit after apply-side inspection changes the
  token, so the native external rejects the stale plan before mutation.

See [`patch-sync.md`](patch-sync.md) for the plan and ownership protocol.
