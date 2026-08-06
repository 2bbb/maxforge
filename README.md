# maxforge

[![npm version](https://img.shields.io/npm/v/maxforge.svg)](https://www.npmjs.com/package/maxforge)
[![Build Max package](https://github.com/2bbb/maxforge/actions/workflows/build-max-package.yml/badge.svg)](https://github.com/2bbb/maxforge/actions/workflows/build-max-package.yml)

[Website](https://2bit.jp/maxforge/) · [Documentation](https://2bit.jp/maxforge/docs/) · [npm](https://www.npmjs.com/package/maxforge) · [Max package releases](https://github.com/2bbb/maxforge/releases)

Unofficial text-first DSL compiler for generating Max/MSP `.maxpat` patches.
Write compact text, get valid Max patch JSON.

maxforge is not affiliated with, endorsed by, or sponsored by Cycling '74.

## Overview

maxforge is for the boring part of Max patching: creating many similar objects,
placing them, and wiring them consistently. Instead of duplicating objects by
hand in the Max GUI, describe the patch as concise `.maxdsl` text and compile it
to `.maxpat`.

It supports:

- **Forward compilation** — `.maxdsl` → `.maxpat` JSON
- **Reverse decompilation** — `.maxpat` → `.maxdsl` text (structure and `at(x, y)` positions round-trip verified; exact source text is not preserved)
- **Clipboard output** — compressed text pasteable directly into Max
- **Clipboard input** — decompress pasted patches back to DSL
- **320 Max 9 object names/aliases with local identity evidence**, plus the project-owned `maxforge.sync` external; port metadata has explicit fixed, argument-dependent, and dynamic categories
- **Subpatcher support** with nested recursion
- **Auto-layout** via topological sort, with optional `at(x, y)` override
- **Macro expansion** — `for`, `if`, and `${expr}` for generating large repeated patches
- **Desired-state diff plans** — stable managed IDs and ordered patch operations for live patch synchronization

## Quickstart

Run without installing globally:

```bash
npx maxforge@latest compile input.maxdsl -o output.maxpat
npx maxforge@latest validate input.maxdsl
```

Try the generative example after cloning this repository:

```bash
npx maxforge@latest compile examples/voice_bank.maxdsl -o voice_bank.maxpat
```

For repository development:

```bash
npm install
npm run build
```

Write a patch:

```maxdsl
patch "Basic Synth"

freq = number
mt = mtof
osc = cycle~ 440
mul = *~ 0.5
vol = gain~
dac = ezdac~

freq -> mt -> osc -> mul -> vol -> dac
vol[1] -> dac[1]
```

Compile:

```bash
node dist/cli/index.js compile basic_synth.maxdsl -o basic_synth.maxpat
```

## Examples

```bash
# Basic hand-written synth patch
npx maxforge@latest compile examples/basic_synth.maxdsl -o basic_synth.maxpat

# Repeated oscillator bank generated with for/if/arithmetic
npx maxforge@latest compile examples/voice_bank.maxdsl -o voice_bank.maxpat
```

`examples/voice_bank.maxdsl` shows the main reason to use maxforge instead of
manual patching: generating many similar Max objects and connections from a
small loop.

## Max / node.script integration (experimental)

maxforge can emit Max `thispatcher` scripting message arrays from `.maxdsl`:

```js
// In a Max node.script file. `max-api` is provided by Max, not by maxforge.
const maxApi = require("max-api");

async function compileToThispatcher(dsl) {
  const { compileDslToThispatcherCommands, loadDatabase } = await import("maxforge");
  const db = await loadDatabase();
  const result = compileDslToThispatcherCommands(dsl, db);

  if (!result.success) {
    maxApi.error(JSON.stringify(result.errors));
    return;
  }

  for (const command of result.commands) {
    if (command.targetPath.length === 0) {
      maxApi.outlet(...command.message);
    } else {
      // Nested subpatcher commands need a Max-side router/helper.
      maxApi.post(JSON.stringify(command));
    }
  }
}

maxApi.addHandler("dsl", compileToThispatcher);
```

Connect the node.script outlet to `thispatcher` for flat patch generation. When using
`{ asSubpatcher: "Name" }` or DSL-defined `p name { ... }`, commands targeting the
inside of the subpatcher are emitted with `targetPath`; plain `thispatcher` does not
magically route those messages into nested patchers. Use a small Max-side router/helper
or generate a flat patch if you need direct outlet-to-`thispatcher` operation today.

A runnable smoke-test patch lives in `examples/max_node_script/`:

```bash
npm install
npm run build
open examples/max_node_script/maxforge_node_script_demo.maxpat
```

The harness patch itself is generated from
`examples/max_node_script/maxforge_node_script_demo.maxdsl` with maxforge; the
runtime payload is `examples/max_node_script/generated_patch.maxdsl`.

## Managed patch synchronization (experimental)

The library API can compile DSL into a scope-owned desired graph and diff it
against the previously applied graph:

```js
import {
  compileDslToPatchGraph,
  createEmptyPatchGraph,
  diffPatchGraphs,
  loadDatabase,
} from "maxforge";

const db = await loadDatabase();
const result = compileDslToPatchGraph(dsl, db, "voices");
if (!result.success) throw new Error(JSON.stringify(result.errors));

const current = createEmptyPatchGraph("voices");
const plan = diffPatchGraphs(current, result.graph);
```

Plans contain ordered `disconnect`, `delete`, `create`, `set`, and `connect`
operations. Objects use stable scripting names derived from the DSL name, so
growing a `for` loop only creates the new instances instead of replacing the
whole generated patch.

Generate a plan from the CLI:

```bash
# Empty managed scope -> desired DSL
npx maxforge@latest plan desired.maxdsl \
  --scope voices \
  --compact \
  -o plan.json

# Diff current desired DSL -> next desired DSL
npx maxforge@latest plan next.maxdsl \
  --scope voices \
  --current current.maxdsl \
  -o plan.json
```

This repository also contains the native `maxforge.sync` Max external. It owns
the loopback WebSocket connection to `maxforge-mcp`, validates complete plans,
and mutates the containing patcher directly through the Max SDK. It does not
route through JavaScript, `thispatcher`, or a separate transport object. Its
`inspect` request walks the live containing patcher and emits a
machine-readable structural snapshot, so an agent does not need the screen or
a saved `.maxpat` to read patch state.

Build and install it for local development:

```bash
git submodule update --init --recursive
cmake -S . -B build
cmake --build build

mkdir -p "$HOME/Documents/Max 9/Packages"
ln -s "$PWD" "$HOME/Documents/Max 9/Packages/maxforge"
# Restart Max after installing an external.
```

Prebuilt Max packages are available from
[GitHub Releases](https://github.com/2bbb/maxforge/releases). `maxforge.zip`
contains both the universal macOS `maxforge.sync.mxo` and x64 Windows
`maxforge.sync.mxe64`, together with `package-info.json`, the `.maxhelp`, its
supporting plan, the Max reference XML, documentation, and examples. Extract
the top-level `maxforge` directory into the Max `Packages` directory. The
moving `latest` release follows successful `main` builds; use a versioned
release when the exact build must remain pinned.

The macOS external is ad-hoc signed but is not notarized. It must not be
described as Gatekeeper-safe. See [`docs/releasing.md`](docs/releasing.md) for
CI triggers, archive validation, private-submodule credentials, and the
versioned release procedure.

Open `examples/max_sync/maxforge_sync_demo.maxpat` for an end-to-end native
example, including managed objects inside a generated subpatcher.

`maxforge.sync` auto-connects and registers after its containing top-level
patcher has a visible view. It verifies `baseRevision` and never touches objects
outside the exact `maxforge_<scope>_obj_...` namespace. Protocol v1 does
**not** provide rollback after a runtime mutation failure. Its outlet remains
available for human-readable status and local diagnostics. See
[`docs/patch-sync.md`](docs/patch-sync.md) for the protocol and failure contract.

### MCP live control

`maxforge-mcp` exposes the managed workflow to MCP clients over stdio:

- `maxforge_help`
- `maxforge_status`
- `maxforge_list_patches`
- `maxforge_create_patch`
- `maxforge_inspect_patch`
- `maxforge_reconcile_patch`
- `maxforge_compile_plan`
- `maxforge_apply_dsl`

`maxforge_reconcile_patch` performs a read-only three-way merge of the last
agent intent, the current live Max graph, and the next complete DSL. Apply with
`manualChanges: "merge"` only when it returns `canApply: true`. Non-conflicting
human edits remain preserved across later reconciliations; same-field and
change-vs-delete conflicts are never resolved by silent overwrite.
Apply-side inspection is bound to native mutation by a structure token, so a
box or cord edit made in between causes rejection rather than stale overwrite.

It listens for native `maxforge.sync` clients only on `127.0.0.1:8766`. Each
live patch contains one `maxforge.sync`, registers a stable `patcherId`, and can
therefore be created or operated as an independent Max window without
ambiguity. No JavaScript or helper patch wiring runs inside Max.

The npm package supplies the `maxforge-mcp` Node.js server, but it does **not**
install the native `maxforge.sync` external into Max. Build/install the external
and open a controller patch before expecting `maxforge_list_patches` to return a
target.

```json
{
  "mcpServers": {
    "maxforge": {
      "command": "npx",
      "args": ["-y", "--package=maxforge@latest", "maxforge-mcp"]
    }
  }
}
```

Open `examples/mcp_bridge/maxforge_mcp_bridge.maxpat` after installing the
native external. The patch contains exactly one configured object and no patch
cords. Agents should call `maxforge_help` with `topic: "workflow"` before their
first mutation and `topic: "recovery"` after an ambiguous failure. See
[`docs/mcp.md`](docs/mcp.md) for tool arguments and result contracts,
transport lifecycle, troubleshooting, state recovery, security boundaries, and
the acknowledgement contract.

## AI agent skills

List the skills exposed by this repository:

```bash
npx skills add 2bbb/maxforge --list
```

Install the offline DSL/compiler skill when the agent creates or validates
`.maxdsl`, `.maxpat`, or `.maxhelp` files:

```bash
npx skills add 2bbb/maxforge --skill maxforge
```

Install the stricter live-control skill when the agent will inspect or mutate an
open Max patch through MCP:

```bash
npx skills add 2bbb/maxforge --skill maxforge-mcp
```

The `maxforge-mcp` skill encodes target selection, complete desired-state
semantics, plan review, revision acknowledgement, post-apply inspection, and
restart/timeout/manual-drift recovery. A skill supplies agent instructions only;
it does not install the npm server or native Max external.

## CLI Reference

After `npm run build`, local development can use `node dist/cli/index.js ...`.
When installed as a package binary, use `maxforge ...`.

```bash
# DSL → maxpat
maxforge compile input.maxdsl -o output.maxpat

# DSL → compressed text (paste into Max with Ctrl+V / Cmd+V)
maxforge compile input.maxdsl --clipboard | pbcopy

# Compressed text → DSL (from stdin)
pbpaste | maxforge from-clipboard -o output.maxdsl

# maxpat → DSL (from file)
maxforge decompile input.maxpat -o output.maxdsl

# Validate without writing output
maxforge validate input.maxdsl

# Desired DSL → managed PatchPlan for maxforge.sync
maxforge plan desired.maxdsl --scope voices --compact -o plan.json

# Diff from a prior desired DSL or a scoped maxpat snapshot
maxforge plan next.maxdsl --scope voices --current current.maxdsl -o plan.json

# Allow objects not in the database
maxforge compile input.maxdsl --allow-unknown -o output.maxpat
```

`--allow-unknown` creates a `newobj` with representative 1-inlet/1-outlet
metadata and skips upper-bound port rejection. It does not verify the external's
real shape. Use it only when Max or the external's own documentation is the
source of truth.

## DSL Syntax

### Patch Declaration (optional)

```maxdsl
patch "Title"
patch "Title" | "Description"
patch "Title" | "Description" | 800x600
```

Default: `"Untitled" | "" | 640x480`

### Object Definition

```maxdsl
name = type [args...] [@attr value...] [at(x, y)]
```

- `name` — identifier, unique within scope
- `type args` — resolved using audited fixed metadata, an explicit argument rule, or a dynamic-port marker
- `@attr value` — optional attributes; emitted directly as box JSON properties
- escape a literal Max object-text attribute as `\@attr`; otherwise maxforge treats it as a box JSON property
- `at(x, y)` — optional position override; omit for auto-layout
- structural keys such as `id`, `maxclass`, `patching_rect`, `text`, and `patcher` are reserved and cannot be set with `@`

```maxdsl
# audio oscillator
osc = cycle~ 440

# signal multiply
mul = *~ 0.5

# attributes
freq = number @minimum 0 @maximum 127
vol = slider @size 20 140

# comment and message boxes
cmt = comment "Hello"
msg = message "open"

# manual position
filt = lores~ 1000 0.5 at(50, 200)
```

Inline comments after a statement are not supported; put comments on their own line.

### Repetition and Arithmetic

Use `for`, `if`, and `${expr}` when Max would otherwise require many similar objects.
Expansion happens before normal parsing.

```maxdsl
for i in 0..7 {
  osc_${i} = cycle~ ${220 + i * 20} at(${50 + i * 100}, 80)
  amp_${i} = *~ 0.125 at(${50 + i * 100}, 140)
  osc_${i} -> amp_${i}

  if i < 2 {
    meter_${i} = meter~ at(${50 + i * 100}, 200)
    amp_${i} -> meter_${i}
  }
}
```

- `0..7` is inclusive; use `step`, e.g. `for i in 0..6 step 2`
- expressions support loop variables, `+ - * /`, parentheses, and comparisons
- `${expr}` can be used in names, object arguments, attributes, positions, and connections
- expressions are deliberately numeric only; there are no strings, arrays, functions, or modulo operator

### Connections

```maxdsl
# chain: outlet 0 → inlet 0
a -> b -> c

# outlet 1 → inlet 1
vol[1] -> dac[1]

# outlet 0 → inlet 2
src[0] -> dst[2]
```

Indices are 0-based (leftmost = 0). `[N]` on a destination means destination inlet `N`.

### Subpatchers

```maxdsl
fx = p delay_fx {
  in = inlet signal "audio input"
  out = outlet signal "audio output"
  buf = tapin~ 500
  tap = tapout~ 250
  fb = *~ 0.4

  in -> buf -> tap -> fb -> buf
  tap -> out
}
```

- `inlet` and `outlet` are the only subpatcher port objects
- add the maxforge-only `signal` modifier (`inlet signal`, `outlet signal`) to emit the real Max `inlet`/`outlet` classes with signal metadata
- `numinlets`/`numoutlets` auto-derived from internal inlet/outlet count
- Nestable

### Argument-dependent Objects

Some objects change inlet/outlet count based on arguments:

| Object | Rule |
|--------|------|
| `gate 4` | outlets = 4 |
| `route 1 2 3` | inlets = outlets = args + 1 in current Max 9 saved patches |
| `sel 1 2 3` | inlets = outlets = args + 1; matched outlets are bang |
| `pack 0 0. 0` | inlets = arg count |
| `unpack 0 0 0` | outlets = arg count |
| `trigger b b f` | outlets = arg count, types from args |
| `matrix~ 4 4` | 4 inlets, 4 signal outlets, plus a status outlet |
| `selector~ 4` | inlets = first arg + 1 |

This table is representative, not exhaustive. `dynamicPorts` objects such as
`poly~`, `bpatcher`, `gen~`, and `jit.gl.slab` do not have a trustworthy fixed
upper port bound. See [Object catalog: evidence and limits](docs/object-catalog.md)
before extending the catalog or relying on generated port metadata.

## Project Structure

```
src/
  cli/index.ts         CLI entry point
  dsl/parser.ts        Line-oriented DSL parser
  dsl/blocks.ts        Shared brace-delimited block collection
  dsl/object-syntax.ts Object attributes and position suffix parsing
  dsl/expander.ts      for/if/${expr} macro expansion
  dsl/expression.ts    Numeric expression evaluator for macro expansion
  core/
    compiler.ts        AST → maxpat JSON compiler
    compiled-model.ts  Compiler intermediate box/line model
    connection-compiler.ts Connection validation and line compilation
    patcher-json.ts    Compiler model → maxpat JSON builder
    port-objects.ts    inlet/outlet object classification helpers
    decompiler.ts      maxpat JSON → DSL text
    attributes.ts      Shared box attribute helpers
    object-db.ts       Object lookup + argDependent resolution
    layout.ts          Auto-layout via topological sort
    clipboard.ts       Compress/decompress for Max clipboard
    serializer.ts      JSON serialization
    types.ts           Type definitions
  max/
    patch-graph.ts     Managed desired graph and PatchPlan diff
    thispatcher.ts     thispatcher command generation
  mcp/
    server.ts          stdio MCP executable
    mcp-server.ts      Agent-facing tools, help, and schemas
    service.ts         Desired-state and inspection baseline service
    bridge.ts          Loopback WebSocket transport to Max
source/projects/
  maxforge.sync/       Native min-api PatchPlan consumer
deps/
  bbb.agent/           Pinned reusable WebSocket transport source
data/
  objects.json         321-entry audited compiler metadata catalog
docs/
  dsl-spec.md          Formal DSL specification (EBNF)
  agent-guide.md       AI agent documentation
  object-catalog.md    Catalog evidence, dynamic ports, and non-claims
  mcp.md               MCP setup, tools, recovery, and troubleshooting
  patch-sync.md        Native PatchPlan ownership protocol
  releasing.md         Max package CI and release procedure
  website.md           GitHub Pages source and deployment procedure
scripts/
  assemble-max-package.sh Build the Max package directory
  audit-object-catalog.py Compare catalog identity/static metadata with local Max 9 resources
  verify-max-package.py   Validate source, package, and ZIP contents
  verify-pages.py         Validate static Pages files and local references
.github/workflows/
  build-max-package.yml Cross-platform external build and release CI
  deploy-pages.yml     Validate and deploy the static project website
site/
  index.html           GitHub Pages entry page
  styles.css           Responsive site presentation
  main.js              Dependency-free copy controls
  docs/index.html      Installation, DSL, MCP, and recovery guide
  docs/docs.css        Documentation-specific layout and typography
  sitemap.xml          Public home and documentation URLs
skills/
  maxforge/            Offline DSL/compiler agent skill
  maxforge-mcp/        Live MCP control agent skill
tests/
  mcp-*.test.ts        MCP server, service, bridge, and example tests
  compiler.test.ts     Compiler/parser/decompiler test suite
  block.test.ts        Brace block parsing regression tests
  expander.test.ts     for/if/${expr} expansion test suite
  native/              Max-independent C++ protocol/validation tests
  fixtures/            DSL fixture files for snapshot testing
examples/
  basic_synth.maxdsl   Example patch
  voice_bank.maxdsl    Repeated-object generation example
  max_sync/            Native external end-to-end example
  mcp_bridge/          MCP-to-native-Max controller example
```

## Development

```bash
npm run build          # compile TypeScript
npm test               # run tests with vitest
npm run dev            # watch mode
npm run pack:dry-run   # inspect npm package contents

# Native protocol tests; no Max application/runtime is required
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DMAXFORGE_BUILD_TESTS=ON
cmake --build build --config Release --parallel 4
ctest --test-dir build --build-config Release --output-on-failure

# Static website validation
python3 scripts/verify-pages.py site
```

## Error Codes

| Code | Meaning |
|------|---------|
| E001 | Duplicate object name |
| E002 | Undefined reference in connection |
| E003 | Unknown object type (not in DB) |
| E004 | Outlet index out of range |
| E005 | Inlet index out of range |
| E006 | inlet/outlet used outside subpatcher |
| E007 | Syntax error |
| E008 | Subpatcher has no inlet or outlet |
| E009 | Reserved attribute key |

## License

MIT
