# Manual Max/MCP test checklist

Run this checklist only after CI passes. It covers behavior that source-level
tests cannot prove. Do not use an important patch: several cases deliberately
restart processes, create files, and mutate patchers.

## Test record

Copy this block into the release/issue record before testing:

```text
Date:
Tester:
Commit/tag:
npm maxforge version:
maxforge.sync externalVersion:
Max version:
MCP host/version:
Node/npm versions:
OS and architecture:
Max package/external path:
MAXFORGE_CONFIG path and project.id:
Result: PASS / FAIL / BLOCKED
Failures and evidence links:
```

For each case, record the target `patcherId`, scope, broker PID, structure token
or revision where relevant. A screenshot is evidence only for UI/security
behavior; use structured MCP output and Max Console text for protocol failures.

## Release gate

For an ordinary release candidate, run H01–H06 and H09 on macOS. Run H07 when
LAN behavior changes, H08 when catalog/config behavior changes, and the Windows
part of H09 when the native external, packaging, or CI toolchain changes.

### H01 — Native external discovery and registration

**Requires:** Max, the release-candidate Max package, and matching npm package.

1. Remove or rename duplicate development copies of `maxforge.sync` from Max
   search paths; otherwise this test proves nothing about the intended binary.
2. Start Max and open `maxforge.sync.maxhelp` from the installed package.
3. Confirm the object is not missing and the Max Console contains no red load,
   class, attribute, WebSocket, or registration error.
4. Start/reconnect the MCP entry and call `maxforge_status`, then
   `maxforge_list_patches`.
5. Confirm the help patch is registered, `externalVersion` equals the npm
   runtime's expected version, and `versionCompatible` is `true`.

**Pass:** the intended binary loads and registers without a Max error.

### H02 — Human edit followed by differential agent sync

**Requires:** a disposable registered patch containing at least three connected
objects.

1. Inspect the target at summary and full detail; retain its structure token.
2. Through the Max UI, move one managed object, add a `button`, and rewire one
   existing patch cord. Do not tell the agent the exact edits.
3. Ask the agent to inspect/review the live changes and explain them from MCP
   state, not from the screen.
4. Confirm `maxforge_get_live_edit_history` and
   `maxforge_review_live_changes` describe the move, addition, and rewire as
   evidence, including any interpretation risk.
5. Adopt the accepted managed edits using the exact current structure token.
6. Ask the agent to add one more object and connection through complete desired
   DSL, preview the plan, then apply it.
7. Inspect again. Confirm the three human edits remain and only the reviewed
   agent delta was added.

**Fail immediately if:** the agent overwrites unreviewed edits, relies on window
appearance, uses a stale token, or treats edit-history inference as human intent.

### H03 — Create, save, close, and reopen a top-level patch

**Requires:** exactly one controller-capable registered patch and a writable
temporary directory.

1. Create a new patch with a unique `patcherId`, scope, and title using
   `maxforge_create_patch`.
2. Confirm it registers as a separate target containing one `maxforge.sync`.
3. Apply a small desired DSL containing `button`, `counter`, and `print`, then
   verify connections by inspection.
4. Save it to an absolute temporary `.maxpat` path with
   `maxforge_save_patch`; confirm Max reports a clean patch and the file exists.
5. Close it through `maxforge_close_patch` and confirm it disappears from the
   target list.
6. Reopen the saved file normally in Max. Because it already contains
   `maxforge.sync`, do **not** pass it to `maxforge_open_patch`. Confirm it
   registers itself and retains the expected graph and saved path.
7. Separately create a plain `.maxpat` with no sync object, open it through
   `maxforge_open_patch`, and confirm Maxforge injects exactly one sync object,
   marks the patch dirty, and registers it as a distinct target.

**Pass:** target identity and graph survive the full file lifecycle without a
duplicate sync object or ambiguous window selection.

### H04 — Persistence across frontend, broker, Max, and MCP-host restarts

**Requires:** the saved H03 patch and a stable `project.id`.

1. Record broker PID, current DSL, graph revision, edit-history persistence
   status, and saved path.
2. Restart only the MCP entry. Confirm it attaches to the same broker PID and
   the target remains inspectable.
3. Close all MCP entries and Max clients; wait past a deliberately short
   `MAXFORGE_BROKER_IDLE_MS`. Confirm `maxforge broker status` can no longer
   connect.
4. Reopen the patch and MCP entry. Confirm a new broker owns the project and
   persisted source/baseline/history are recovered without a writer-lock error.
5. Quit Max without stopping the broker, reopen Max and the saved patch, and
   confirm native retry registration restores inspection.
6. Restart the outer MCP host (for example Codex) once. Confirm its configured
   Maxforge entry initializes and can list the same target.

**Pass:** each restart has the documented ownership behavior; no stale target,
duplicate owner, or silent loss of persisted state appears.

### H05 — Package-version mismatch and broker upgrade

**Requires:** two Maxforge npm versions and no valuable pending operation.

1. Start a broker with the older package, then start the MCP entry with the
   newer package for the same project.
2. Confirm MCP initialization succeeds in diagnostic mode, only
   `maxforge_status` is exposed, and it reports `VERSION_MISMATCH` with both
   versions and the old broker PID.
3. Stop/restart the broker with the intended package. Use `--force` only after
   confirming that disconnecting clients is acceptable.
4. Call status again from the still-open diagnostic entry. Confirm it reports
   `RECONNECT_REQUIRED`, the replacement PID/version, and still does not expose
   mutation tools.
5. Reconnect that MCP entry without restarting the outer host. Confirm the full
   tool set appears and normal patch listing works.

**Pass:** mismatch never exposes mutation tools, status is live rather than
stale, and reconnect—not a full host restart—completes the upgrade.

### H06 — Max error-channel behavior

1. In a disposable patch instantiate
   `maxforge.sync @host 192.0.2.1` without a token. A non-loopback host without
   `@token` is deliberately rejected before a network connection is attempted.
2. Confirm the message appears in the Max Console with error severity (red),
   not as an ordinary `post` line.
3. Restore valid settings and confirm subsequent registration succeeds without
   restarting Max unless the error explicitly requires it.

**Pass:** actionable native failures use Max's error channel and recovery is
observable.

### H07 — Authenticated LAN operation

**Requires:** two machines on a trusted LAN and firewall access to the selected
port.

1. On the broker machine, set a human-chosen `MAXFORGE_WS_TOKEN`; confirm the
   effective bind is non-loopback (or the explicitly configured LAN address).
2. On the Max machine, configure `maxforge.sync` with the broker machine's LAN
   address, port, and matching token.
3. Confirm registration, inspect, one previewed apply, and acknowledgement.
4. Change the Max-side token to an incorrect value. Confirm registration and
   mutation are rejected without leaking the configured token in logs.
5. Remove the token while requesting a non-loopback bind. Confirm startup is
   rejected. Do not expose this plaintext WebSocket directly to the Internet.

**Pass:** only the matching token controls the patch across the LAN and secrets
are absent from evidence.

### H08 — Project external and abstraction catalog

1. Configure one custom external and one abstraction in the project catalog,
   including accurate `ports.mode`/rules and artifact/search paths.
2. Start MCP with the absolute `MAXFORGE_CONFIG` path and verify both entries via
   `maxforge_catalog`.
3. Instantiate both through desired DSL in Max and verify actual inlet/outlet
   topology.
4. Change catalog metadata, call `maxforge_reload_catalog`, and verify the digest
   changes without dropping the Max registration.
5. Remove the actual Max artifact while leaving the declaration. Confirm the
   compiler catalog still lists it but Max reports the runtime load failure.

**Pass:** declared metadata controls compilation while runtime availability is
correctly treated as a separate Max search-path concern.

### H09 — Published npm and downloadable Max package

1. In a clean temporary directory, invoke the exact published version with
   `npx -y --package=maxforge@<version> maxforge --help`, then initialize
   `npx -y --package=maxforge@<version> maxforge-mcp` from an MCP test client.
2. Confirm MCP returns an initialize response when invoked through npm's bin
   link, not only through `node dist/...`.
3. Download `maxforge.zip` from the matching GitHub release and verify its
   recorded checksum before extraction.
4. Install the package through Max's supported package/search-path mechanism.
5. On macOS, confirm the universal external loads after the documented security
   action, if any. On Windows, confirm the x64 `.mxe64` loads in Max.
6. Open the shipped help patch and repeat H01's version-compatible registration
   check.

**Pass:** npm version, native external version, Git tag/release, and downloaded
artifact all identify the same source and work from clean installation paths.

## Cleanup

- Close disposable patches without saving unintended changes.
- Delete H03 temporary `.maxpat` files.
- Restore normal MCP package version, broker idle timeout, config, bind address,
  token, and firewall rules.
- Stop test brokers only after confirming no other MCP/Max client uses the same
  `project.id`.
- Restore renamed external copies deliberately; do not leave duplicate active
  copies in Max search paths.
