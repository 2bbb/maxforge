# Max package releases

GitHub Actions builds `maxforge.sync` for macOS and Windows and publishes one
installable Max package archive. This is separate from the npm package: npm
provides the DSL CLI and MCP server, while the versioned
`maxforge-vX.Y.Z.zip` provides the native external and its Max-facing resources.

## Archive contract

For version `X.Y.Z`, the release assets are named
`maxforge-vX.Y.Z.zip` and `maxforge-vX.Y.Z.zip.sha256`. The archive has one
top-level `maxforge` directory:

```text
maxforge/
├── externals/
│   ├── maxforge.sync.mxo      # universal x86_64 + arm64
│   └── maxforge.sync.mxe64    # Windows x64
├── help/
│   ├── maxforge.sync.maxhelp
│   └── managed_plan.json
├── docs/
│   └── maxforge.sync.maxref.xml
├── examples/
├── package-info.json
├── README.md
└── LICENSE
```

The workflow fails before publishing if either external, the help patch, the
help patch's plan, or the Max reference is absent or malformed. It also checks
that `package-info.json` declares those files and has the same version as
`package.json`. The Ubuntu validation job runs the TypeScript build and Vitest
suite. Both native build jobs compile and run the Max-independent C++ protocol
suite with CTest before their external artifact can be uploaded.

The final archive is made on a macOS runner with `ditto`, after restoring the
external binary's executable permission. Do not replace it with a ZIP rebuilt
on Linux after CI: that can damage macOS bundle metadata and permissions.

## Workflow triggers

`.github/workflows/build-max-package.yml` runs on:

- pull requests targeting `main`: build, test, validate, and upload the Actions
  artifact only;
- pushes to `main`: do the same and upload a version-named Actions artifact;
- a published GitHub Release: rebuild the tagged source and attach
  `maxforge-vX.Y.Z.zip` and its checksum to that versioned release; the workflow
  rejects a release tag that differs from `package.json`;
- manual `workflow_dispatch`: build and upload the Actions artifact without
  changing a release.

Push and pull-request runs use one concurrency group per event and ref. A newer
commit cancels an older run for the same branch. Published-release and manual
runs are not auto-cancelled. There is deliberately no moving `latest` Git tag,
GitHub Release, or unversioned public ZIP: live MCP compatibility requires a
one-to-one npm version, Git tag, and native package.

The package combines both platforms, matching the other bbb Max packages. Max
ignores the external extension for the other platform.

## Private `bbb.agent` dependency

`deps/bbb.agent` is private. A normal `GITHUB_TOKEN` from the public
`bbb-max-externals/maxforge` repository cannot read it. Both external build jobs therefore
require a repository secret named `BBB_AGENT_DEPLOY_KEY` containing a raw
private SSH key whose public half is a read-only deploy key on
`bbb-max-externals/bbb.agent`.

One-time setup:

```bash
ssh-keygen -t ed25519 -C maxforge-ci -f /tmp/maxforge-ci -N ''
gh repo deploy-key add /tmp/maxforge-ci.pub \
  --repo bbb-max-externals/bbb.agent \
  --title 'maxforge GitHub Actions'
gh secret set BBB_AGENT_DEPLOY_KEY \
  --repo bbb-max-externals/maxforge \
  < /tmp/maxforge-ci
rm /tmp/maxforge-ci /tmp/maxforge-ci.pub
```

Do not grant write access to the deploy key. The workflow deliberately checks
out only `bbb.agent`'s `deps/IXWebSocket` nested submodule; it does not recurse
into the development-only Skill submodules.

Secrets are not exposed to workflows from forked pull requests. Such PRs
cannot build the external while `bbb.agent` remains private. Making that
dependency public or moving the shared transport into a public source
dependency is the only way to remove this limitation; workflow tricks do not
solve it safely.

## macOS signing and notarization

CI replaces the min-api ad-hoc signature with the configured Developer ID
Application signature, and verifies the authority, team ID, bundle identifier,
universal architectures, and executable permission. Release, main-push, and
manual package builds submit the final versioned ZIP to Apple's notarization
service and verify the accepted archive before upload. These paths require the
documented signing/notarization secrets; a missing credential fails the build
rather than silently producing an unsigned public package.

## Versioned release procedure

Keep `package.json`, `package-lock.json`, and `package-info.json` on the same
version. `npm version <version> --no-git-tag-version` updates the first two;
update `package-info.json` in the same release commit. The verifier rejects a
mismatch between the two package manifests.

Run the complete checks from a clean `main` checkout:

```bash
npm run build
npm run typecheck:tests
npm run test:coverage
npm run test:package
npm run docs:check
npm audit --omit=dev --audit-level=high
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DMAXFORGE_BUILD_TESTS=ON
cmake --build build --config Release --parallel 4
ctest --test-dir build --build-config Release --output-on-failure
python3 scripts/verify-max-package.py --source .
npm run pack:dry-run
```

Commit and push the synchronized version files. Wait for the `main` workflow to
succeed before publishing either distribution. Create the matching Git tag and
GitHub Release from that exact commit first:

```bash
git tag v<VERSION>
git push origin v<VERSION>
gh release create v<VERSION> --verify-tag --generate-notes
```

For example, version `0.1.6` uses tag `v0.1.6`. Never move or reuse a published
tag/version: npm versions are immutable, and GitHub and npm must identify the
same source commit.

Publishing the GitHub Release starts a clean macOS and Windows rebuild. Do not
upload a locally built external as a substitute. Confirm that the workflow is
green and the release contains `maxforge-v<VERSION>.zip` plus its checksum.
Only then publish npm from the same clean tagged commit:

```bash
npm publish
```

This order prevents npm's `latest` dist-tag from pointing to a version whose
matching native package is not available yet. The brief inverse state—native
artifact available before npm—is harmless because no MCP runtime can request it
as the published npm version.

## Local checks

Source/package metadata can be checked without building an external:

```bash
python3 scripts/verify-max-package.py --source .
```

After placing both CI-built externals in `dist/maxforge/externals/`:

```bash
scripts/assemble-max-package.sh dist/maxforge
python3 scripts/verify-max-package.py --package dist/maxforge
version="$(node -p 'require("./package.json").version')"
ditto -c -k --keepParent dist/maxforge "dist/maxforge-v${version}.zip"
python3 scripts/verify-max-package.py --archive "dist/maxforge-v${version}.zip"
```
