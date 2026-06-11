# maxpat-dsl

DSL compiler for Max/MSP `.maxpat` patches. Write compact text, get valid Max patch JSON.

## Overview

maxpat-dsl is a domain-specific language and compiler that lets you describe Max/MSP patches as concise text files (`.maxdsl`) instead of editing JSON by hand or clicking through the Max GUI. It supports:

- **Forward compilation** — `.maxdsl` → `.maxpat` JSON
- **Reverse decompilation** — `.maxpat` → `.maxdsl` text (round-trip verified)
- **Clipboard output** — compressed text pasteable directly into Max
- **Clipboard input** — decompress pasted patches back to DSL
- **374 built-in objects** with auto inlet/outlet resolution
- **Subpatcher support** with nested recursion
- **Auto-layout** via topological sort, with optional `at(x, y)` override

## Quickstart

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

## CLI Reference

```bash
# DSL → maxpat
maxpat-dsl compile input.maxdsl -o output.maxpat

# DSL → compressed text (paste into Max with Ctrl+V / Cmd+V)
maxpat-dsl compile input.maxdsl --clipboard | pbcopy

# Compressed text → DSL (from stdin)
pbpaste | maxpat-dsl from-clipboard -o output.maxdsl

# maxpat → DSL (from file)
maxpat-dsl decompile input.maxpat -o output.maxdsl

# Validate without writing output
maxpat-dsl validate input.maxdsl

# Allow objects not in the database
maxpat-dsl compile input.maxdsl --allow-unknown -o output.maxpat
```

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
- `type args` — resolved against the object database; `numinlets`/`numoutlets` auto-derived
- `@attr value` — optional attributes; emitted directly as box JSON properties
- `at(x, y)` — optional position override; omit for auto-layout

```maxdsl
osc = cycle~ 440              # audio oscillator
mul = *~ 0.5                  # signal multiply
freq = number @minimum 0 @maximum 127  # with range
vol = slider @size 20 140     # with custom size
cmt = comment "Hello"         # comment
msg = message "open"          # message box
filt = lores~ 1000 0.5 at(50, 200)  # with position
```

### Connections

```maxdsl
a -> b -> c          # chain: outlet 0 → inlet 0
vol[1] -> dac[1]     # outlet 1 → inlet 1
src[0] -> dst[2]     # outlet 0 → inlet 2
```

Indices are 0-based (leftmost = 0).

### Subpatchers

```maxdsl
fx = p delay_fx {
  in = inlet~ "audio input"
  out = outlet~ "audio output"
  buf = tapin~ 500
  tap = tapout~ 250
  fb = *~ 0.4

  in -> buf -> tap -> fb -> buf
  tap -> out
}
```

- `inlet`/`outlet`/`inlet~`/`outlet~` only valid inside subpatchers
- `numinlets`/`numoutlets` auto-derived from internal inlet/outlet count
- Nestable

### Argument-dependent Objects

Some objects change inlet/outlet count based on arguments:

| Object | Rule |
|--------|------|
| `gate 4` | outlets = 4 |
| `route 1 2 3` | outlets = args + 1 |
| `pack 0 0. 0` | inlets = arg count |
| `unpack 0 0 0` | outlets = arg count |
| `trigger b b f` | outlets = arg count, types from args |
| `matrix~ 4 4` | inlets = first arg, outlets = second |
| `selector~ 4` | inlets = first arg + 1 |

## Project Structure

```
src/
  cli/index.ts         CLI entry point
  dsl/parser.ts        Line-oriented DSL parser
  core/
    compiler.ts        AST → maxpat JSON compiler
    decompiler.ts      maxpat JSON → DSL text
    object-db.ts       Object lookup + argDependent resolution
    layout.ts          Auto-layout via topological sort
    clipboard.ts       Compress/decompress for Max clipboard
    serializer.ts      JSON serialization
    types.ts           Type definitions
data/
  objects.json         374-object database
docs/
  dsl-spec.md          Formal DSL specification (EBNF)
  skill.md             AI agent documentation
tests/
  compiler.test.ts     48 tests (snapshot, round-trip, errors, edge cases)
  fixtures/            DSL fixture files for snapshot testing
examples/
  basic_synth.maxdsl   Example patch
```

## Development

```bash
npm run build          # compile TypeScript
npm test               # run 48 tests with vitest
npm run dev            # watch mode
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

## License

MIT
