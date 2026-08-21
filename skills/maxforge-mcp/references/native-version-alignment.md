# Native package version alignment

Use this procedure when `maxforge_list_patches` reports
`versionCompatible: false`, or when the loaded `externalVersion` differs from
`maxforge_status.bridge.expectedExternalVersion`. The target is the intended
exact npm frontend version, not whichever old broker happens to be running and
not another version merely because it is newer.

This installer contract is available from release `v0.5.0`. Releases through
`v0.4.4` published a legacy unversioned native archive, so an exact legacy
asset will not exist under the filename required below. Do not reinterpret that
as permission to use `latest`: migrate the npm frontend, broker, and complete
native package together to one versioned release, or stop and report that a
manual legacy migration is required.

## 1. Establish the exact target and destination

1. For mismatch repair, record the exact `X.Y.Z` pinned in the MCP frontend
   configuration. For an explicitly requested full update, use only the coherent
   target established by [`update-workflow.md`](update-workflow.md), after its
   MCP pin and broker steps. If status reports `VERSION_MISMATCH`,
   close/disconnect clients as required and restart the broker with that exact
   package first. Only then require `bridge.expectedExternalVersion` to equal
   `X.Y.Z`.
2. Locate active `maxforge` package roots in bounded Max search locations:
   - the current user's `Documents/Max <major>/Packages/maxforge`;
   - package roots explicitly configured in Max;
   - project-local search paths declared by the current project.
3. A patch `filepath` is only a locator. It does not identify the external Max
   resolved.
4. If one existing active package root is authoritative, replace that whole
   package. If none exists, use the user package directory for the installed
   Max major version. Do not infer the major version from a guessed default.
5. If multiple active copies exist, do not overwrite all of them. Report the
   exact candidate paths once and ask which search-path copy should remain.
   Obsolete copies must be moved outside every Max search path.

The destination passed to the installer is the complete root named `maxforge`,
not `Packages`, `externals`, or the binary itself. Replacing only
`maxforge.sync.mxo`/`.mxe64` can leave stale help, reference, and package
metadata and is therefore forbidden.

## 2. Download, verify, back up, and replace

Tell the user that Max must close, because a running process retains the loaded
binary. Close Max only after receiving permission when doing so would discard
unsaved patches. Then execute the script bundled with this skill:

```bash
node <skill-directory>/scripts/align-native-package.mjs \
  --version X.Y.Z \
  --destination /absolute/Max/search/path/maxforge
```

On Windows, invoke the same script with Node and an absolute Windows path. The
script:

- downloads only release tag `vX.Y.Z` from
  `bbb-max-externals/maxforge`;
- requires `maxforge-vX.Y.Z.zip` and its matching `.sha256` file;
- verifies the checksum filename and digest before extraction;
- verifies the complete Max package structure and `package-info.json` version;
- verifies the Developer ID signature before macOS installation;
- refuses installation while Max is running;
- copies the previous package to `~/.maxforge/backups/native` outside Max search
  paths, then replaces the complete package with rollback on rename failure.

Use `--verify-only` to diagnose the artifact without changing the installed
package. `--archive` and `--checksum` are for a previously downloaded exact
pair; never combine assets from different releases.

If the versioned release or checksum is absent, stop. Do not fall back to a
moving `latest` release, a main-branch Actions artifact, a locally built binary,
or another version. That absence means the npm/native release set is
incomplete and should be reported as a release defect.

Network access and writes to the Max package directory may require host
approval. Request only those concrete permissions; do not ask again whether to
perform alignment after the user already requested it.

## 3. Remove ambiguity and re-register

1. Move confirmed obsolete duplicate packages to the backup location outside
   all Max search paths. Never keep a renamed `.mxo` or backup package beside
   the active copy; Max may still discover it.
2. Pin MCP and broker commands to the same exact `maxforge@X.Y.Z`. npm's
   `latest` dist-tag may be queried once to discover the current published
   version, but never use `maxforge@latest` as the live command or saved
   configuration. Copy the discovered semantic version and pin it explicitly.
3. Restart the broker with that exact package version if its runtime differs.
4. Start Max, reopen the controller patch, and reconnect the MCP frontend.
5. Call `maxforge_status`, then `maxforge_list_patches`. Continue only when the
   expected, broker, frontend, and loaded external versions are all `X.Y.Z` and
   the target reports `versionCompatible: true`.

Failure at the final check is usually an unresolved duplicate/search-path
problem. Do not repeatedly reinstall the same archive. Identify the binary Max
actually resolves before attempting another mutation.
