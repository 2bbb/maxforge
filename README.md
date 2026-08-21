# maxforge

> [!WARNING]
> This repository is published as AI-assisted, insufficiently tested work in progress ("AI slop"). Treat it as experimental. Correctness, stability, compatibility, and fitness for production use are not guaranteed.

[![npm version](https://img.shields.io/npm/v/maxforge.svg)](https://www.npmjs.com/package/maxforge)
[![Build Max package](https://github.com/bbb-max-externals/maxforge/actions/workflows/build-max-package.yml/badge.svg)](https://github.com/bbb-max-externals/maxforge/actions/workflows/build-max-package.yml)

[Website](https://2bit.jp/maxforge/) · [Documentation](https://2bit.jp/maxforge/docs/) · [npm](https://www.npmjs.com/package/maxforge) · [Max package releases](https://github.com/bbb-max-externals/maxforge/releases)

maxforge is an unofficial toolkit for describing Max patches as text. Its main
use case is generating repeated object and connection structures that are
tedious to build by hand.

It is not affiliated with, endorsed by, or sponsored by Cycling '74.

## What it provides

The offline toolchain can:

- compile `.maxdsl` text to `.maxpat` JSON;
- generate repeated structures with `for`, `if`, and numeric expressions;
- validate objects and ports against built-in or project-supplied metadata;
- decompile supported `.maxpat` structure back to DSL; and
- emit Max clipboard text or a portable package directory.

The repository also contains an **experimental** live-control stack:

- `maxforge-mcp`, a Node.js MCP server; and
- `maxforge.sync`, a native Max external that inspects and mutates its
  containing patcher.

The live stack is a managed desired-state system, not a general Max automation
API, Max undo replacement, or transaction engine.

## Quick start

Node.js 20 or newer is required for the npm tools.

```bash
npx maxforge@latest compile input.maxdsl -o output.maxpat
npx maxforge@latest validate input.maxdsl
```

A small repeated patch:

```maxdsl
patch "Oscillator bank"

for i in 0..7 {
  osc_${i} = cycle~ ${220 + i * 20}
  amp_${i} = *~ 0.125
  osc_${i} -> amp_${i}
}
```

Compile the included example:

```bash
npx maxforge@latest compile examples/voice_bank.maxdsl -o voice_bank.maxpat
```

The range is inclusive. Expansion is bounded; it is not an unrestricted
programming language. See the [DSL specification](docs/dsl-spec.md) for exact
syntax and limits.

## CLI

Common commands:

```bash
maxforge compile input.maxdsl -o output.maxpat
maxforge decompile input.maxpat -o output.maxdsl
maxforge validate input.maxdsl
maxforge catalog cycle~ --json
maxforge doctor --input input.maxdsl
maxforge bundle input.maxdsl -o my-package
```

Run `npx maxforge@latest --help` or read the [CLI guide](docs/cli.md) for all
commands and options. Third-party externals and abstractions require explicit
metadata; see [Object catalogs](docs/object-catalog.md).

## Live control through MCP

Live control requires both the npm server and the native `maxforge.sync`
external. Installing the npm package does **not** install the external into Max.

Codex configuration:

```toml
[mcp_servers.maxforge]
command = "npx"
args = ["-y", "--package=maxforge@X.Y.Z", "maxforge-mcp"]
```

Replace `X.Y.Z` with one exact release and install its matching
`maxforge-vX.Y.Z.zip` Max package from
[GitHub Releases](https://github.com/bbb-max-externals/maxforge/releases). Do
not leave a live MCP configuration on `@latest`: the npm runtime and loaded
native external must match exactly. Then open a patch containing one
`maxforge.sync` object. The server listens on `127.0.0.1:8766` by default.

Each MCP invocation is a thin stdio frontend. The first frontend starts a
detached project broker; later sessions attach to that broker instead of
competing for the WebSocket port or project state. The broker remains alive
while any MCP or Max client is connected and exits after an idle grace period.

Read [MCP setup and tool contracts](docs/mcp.md) before relying on live
mutation. The shorter [native synchronization overview](docs/patch-sync.md)
documents ownership, revisions, rollback limits, and failure handling.

## Other integrations

- [`node.script` / `thispatcher`](docs/node-script.md) — command generation for
  flat patches; nested targets require Max-side routing.
- [AI agent guide](docs/agent-guide.md) — guidance for generating DSL and using
  managed live control.
- Repository skills:

  ```bash
  npx skills add bbb-max-externals/maxforge --skill maxforge
  npx skills add bbb-max-externals/maxforge --skill maxforge-mcp
  ```

Skills do not install the npm server. When live inspection proves that the
native version is mismatched, the `maxforge-mcp` skill can download, verify,
back up, and replace the complete matching Max package after obtaining the
required host permissions. On the first maxforge-related task in an Agent
session, both skills refresh their tracked source hash before running the cached
release/runtime preflight. Generic Max/MSP questions do not trigger it. A skill
refresh changes instructions only; an authorized runtime update separately pins
MCP, replaces the detached broker and complete Max package, then requests only
the necessary Codex/Max restarts.

## Documentation

| Topic | Document |
|---|---|
| DSL grammar, expansion, errors, and output | [docs/dsl-spec.md](docs/dsl-spec.md) |
| CLI commands and options | [docs/cli.md](docs/cli.md) |
| External and abstraction metadata | [docs/object-catalog.md](docs/object-catalog.md) |
| MCP setup, tools, persistence, security, and recovery | [docs/mcp.md](docs/mcp.md) |
| Native managed-patch protocol | [docs/patch-sync.md](docs/patch-sync.md) |
| `node.script` integration | [docs/node-script.md](docs/node-script.md) |
| Module boundaries | [docs/architecture.md](docs/architecture.md) |
| Local development and testing | [docs/development.md](docs/development.md) |
| Release process | [docs/releasing.md](docs/releasing.md) |

## Current limits

- Decompilation reconstructs supported structure; it does not recover the
  original source text or every Max-specific field.
- Object metadata is a validation aid, not proof that an object is installed or
  behaves identically on every Max version.
- Auto-layout is basic and deterministic, not a replacement for manual visual
  design.
- Live control manages only its declared scope. It does not guarantee complete
  rollback of runtime state after a failed mutation.
- Local macOS builds are ad-hoc signed. Published versioned release archives
  are Developer ID signed and notarized by CI; do not redistribute a local
  build as if it were a release artifact.

The detailed documents state narrower limits for each subsystem. Those limits
are part of the contract, not optional caveats.

## Development

```bash
npm install
npm run build
npm test
```

See [docs/development.md](docs/development.md) for native builds, coverage,
package validation, website checks, and the repository map. Release tags are
created only as part of the versioned release procedure.

## License

MIT
