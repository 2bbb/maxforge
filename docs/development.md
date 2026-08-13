# Development guide

This document covers local repository work. End-user CLI and MCP setup live in
[CLI guide](cli.md) and [MCP control](mcp.md).

## Prerequisites

- Node.js 20 or newer
- npm
- CMake and a C++17 compiler for the native external
- Git submodules for min-api, `bbb.agent`, and IXWebSocket

The Max application is not required for TypeScript tests or the native protocol
unit test. It is required only for host-level integration testing.

## TypeScript build and tests

```bash
npm install
npm run build
npm test
npm run test:coverage
npm run pack:dry-run
```

The coverage command enforces the thresholds configured in
`vitest.config.ts`. CLI and executable-entrypoint tests also spawn built files
as subprocesses.

## Native build and unit test

```bash
git submodule update --init --recursive
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DMAXFORGE_BUILD_TESTS=ON
cmake --build build --config Release --parallel 4
ctest --test-dir build --build-config Release --output-on-failure
python3 scripts/verify-max-package.py --source .
```

The local macOS build writes `externals/maxforge.sync.mxo`. GitHub Actions
builds and tests the macOS and Windows artifacts used for releases.

## Website validation

CI stages public schemas under the site before validation. Reproduce that
without leaving generated files in the repository:

```bash
pages_dir=$(mktemp -d)
cp -R site/. "$pages_dir"
mkdir -p "$pages_dir/schema"
cp schema/*.json "$pages_dir/schema/"
python3 scripts/verify-pages.py "$pages_dir"
node --check site/main.js
```

See [Project website](website.md) for deployment details.

## Repository map

| Path | Responsibility |
|---|---|
| `src/dsl/` | Parser, brace blocks, macro expansion, numeric expressions |
| `src/core/` | Compilation, decompilation, layout, catalogs, serialization |
| `src/max/` | Patch graph, plans, snapshots, merge, `thispatcher` commands |
| `src/mcp/` | MCP entrypoint, tools, service, persistence, WebSocket bridge |
| `source/projects/maxforge.sync/` | Native min-api external |
| `tests/` | TypeScript, subprocess, package, and native protocol tests |
| `data/objects.json` | Built-in object metadata used by the compiler |
| `schema/` | Project and reusable catalog JSON Schemas |
| `examples/` | Offline, `node.script`, native sync, and MCP examples |
| `skills/` | Offline and live-control agent instructions |
| `site/` | Static GitHub Pages source |
| `scripts/` | Package assembly and validation scripts |

Module dependency rules are documented in [Architecture](architecture.md).

## Release boundary

Do not create version tags merely because a change reaches `main`. npm version,
Git tag, GitHub Release, and release artifacts must identify the same reviewed
source commit. Follow [Max package releases](releasing.md) when preparing a
versioned release.
