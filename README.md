# maxpat-dsl

DSL compiler for Max/MSP `.maxpat` patches. Write compact text, get valid Max patch JSON.

## Overview

maxpat-dsl is a domain-specific language and compiler that lets you describe Max/MSP patches as concise text files (`.maxdsl`) instead of editing JSON by hand or clicking through the Max GUI. It supports:

- **Forward compilation** — `.maxdsl` → `.maxpat` JSON
- **Reverse decompilation** — `.maxpat` → `.maxdsl` text (structure and `at(x, y)` positions round-trip verified; exact source text is not preserved)
- **Clipboard output** — compressed text pasteable directly into Max
- **Clipboard input** — decompress pasted patches back to DSL
- **374 built-in objects** with auto inlet/outlet resolution
- **Subpatcher support** with nested recursion
- **Auto-layout** via topological sort, with optional `at(x, y)` override
- **Macro expansion** — `for`, `if`, and `${expr}` for generating large repeated patches

## Quickstart

Run without installing globally after the package is published:

```bash
npx maxpat-dsl compile input.maxdsl -o output.maxpat
npx maxpat-dsl validate input.maxdsl
```

For local package smoke testing before publishing:

```bash
npm run build
pkg="$(npm pack | tail -1)"
npm exec --package "./$pkg" -- maxpat-dsl validate examples/basic_synth.maxdsl
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

## CLI Reference

After `npm run build`, local development can use `node dist/cli/index.js ...`.
When installed as a package binary, use `maxpat-dsl ...`.

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
data/
  objects.json         374-object database
docs/
  dsl-spec.md          Formal DSL specification (EBNF)
  skill.md             AI agent documentation
tests/
  compiler.test.ts     compiler/parser/decompiler test suite
  block.test.ts        brace block parsing regression tests
  expander.test.ts     for/if/${expr} expansion test suite
  fixtures/            DSL fixture files for snapshot testing
examples/
  basic_synth.maxdsl   Example patch
```

## Development

```bash
npm run build          # compile TypeScript
npm test               # run tests with vitest
npm run dev            # watch mode
npm run pack:dry-run   # inspect npm package contents
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
