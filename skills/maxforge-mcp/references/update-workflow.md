# Exact-version update workflow

Use this workflow only after the user requests an update. An available release
is notification, not authorization to mutate configuration or installations.

## 1. Refresh Agent instructions first

Run the installed skill's refresher before using its other procedures:

```bash
node <skill-directory>/scripts/refresh-skills.mjs --json
```

It validates the tracked source as `bbb-max-externals/maxforge`, asks the Skills
CLI to update only installed `maxforge`/`maxforge-mcp` skills, and caches a
successful check for 24 hours. The Skills CLI has no check-only mode, so changed
skills are replaced. If `reloadRequired` is true, read the newly installed
`SKILL.md` and this reference again before continuing. Do not continue from the
old in-memory instructions.

`unknown` means freshness was not established. Local work may continue, but do
not claim the skill is current. `blocked` means the lock source/path/hash is not
trusted; do not execute an updater from that lock.

## 2. Establish one coherent target

Run the refreshed skill's version checker:

```bash
node <skill-directory>/scripts/check-version.mjs --json
```

The target must be one exact semantic version published by both npm and the
latest stable GitHub Release, with both `maxforge-vX.Y.Z.zip` and its `.sha256`
asset present. If those disagree or assets are incomplete, stop the update. Do
not use an Actions artifact, main-branch build, another release, or a moving
`latest` package specifier.

Record separately:

- whether the MCP config pin must change;
- the running broker version and connected-client/pending-operation counts;
- every candidate Max package root;
- whether Max was running before the update.

Multiple active Max package roots are ambiguous. Ask which search-path copy is
authoritative and move confirmed stale copies outside Max search paths; never
overwrite every candidate.

## 3. Quiesce Max and live mutation

Stop mutation before changing any version. If Max is running, tell the user to
save required patches and close Max, then verify the process exited. Never force
quit Max when unsaved work may exist. If Max was not running, record that fact;
there is no Max process to restart at the end.

Do not replace a native package while Max is running. A closed patch window is
not sufficient because another patch may have loaded the external.

## 4. Rewrite only the Codex MCP pin

Validate first, then apply:

```bash
node <skill-directory>/scripts/set-codex-mcp-version.mjs \
  --version X.Y.Z \
  --config /absolute/path/to/config.toml \
  --dry-run --json

node <skill-directory>/scripts/set-codex-mcp-version.mjs \
  --version X.Y.Z \
  --config /absolute/path/to/config.toml \
  --json
```

The setter changes only the `maxforge@...` specifier inside
`[mcp_servers.maxforge].args`, backs up the complete config under
`~/.maxforge/backups/codex-config`, and writes atomically. It refuses missing,
unknown, or duplicate package specifiers and does not print the config body.
Never rebuild the whole config from a template: unrelated MCP entries, tokens,
environment variables, and comments must survive.

If the entry already uses a future Max-package-bundled launcher rather than an
npm specifier, stop and follow that launcher's migration contract instead of
forcing the legacy npx form back into the config.

## 5. Replace the broker deliberately

The detached broker may outlive the frontend that created it. Updating the MCP
pin alone does not update that process. Inspect it with the exact target package:

```bash
npx -y --package=maxforge@X.Y.Z maxforge broker status \
  --config /absolute/path/maxforge.config.json
```

If no broker is running, no lifecycle action is required; the new frontend will
start one. If it is running and idle, restart it with the exact target package.
If connected frontends or pending native operations exist, do not pretend the
restart is safe. Finish/cancel pending work and explain that the current MCP
connection will be disconnected. Use `broker restart --force` only after the
human accepts that disconnection. Never interrupt a pending native operation.

```bash
npx -y --package=maxforge@X.Y.Z maxforge broker restart \
  --config /absolute/path/maxforge.config.json [--force]
```

Retained broker state must be restored normally. Do not delete state/history to
make a version mismatch disappear.

## 6. Replace the complete Max package

With Max closed, run the exact-asset installer from
[`native-version-alignment.md`](native-version-alignment.md):

```bash
node <skill-directory>/scripts/align-native-package.mjs \
  --version X.Y.Z \
  --destination /absolute/Max/search/path/maxforge
```

Replace the complete package, not only `maxforge.sync.mxo`/`.mxe64`. Require the
checksum, package metadata, required help/reference files, and macOS Developer
ID verification. Preserve the installer's backup path for rollback.

## 7. Request only necessary restarts

After all file/process changes:

- Ask the user to restart Codex when the skill changed or the MCP config pin
  changed. A client that can explicitly unload and reconnect one MCP server may
  use that instead, but a new Agent session is required to guarantee refreshed
  skill instructions.
- Ask the user to relaunch Max only when Max was running before the update. If it
  was not running, say that no Max restart is needed; the next normal launch will
  load the replacement.
- Do not claim completion before the required client reconnect occurs.

## 8. Verify after reconnect

After Codex reconnects and Max is available, call `maxforge_status`, then
`maxforge_list_patches`. Require the frontend, broker, expected external, and
loaded external versions to equal `X.Y.Z`, and every target to report
`versionCompatible: true`. If no Max restart was needed because Max was closed,
verification waits until the user next launches Max and opens a controller.

If verification fails, identify a stale broker or duplicate Max search-path copy.
Do not repeat downloads or overwrite additional candidates by guesswork.
