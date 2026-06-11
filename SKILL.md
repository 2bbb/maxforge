---
name: maxforge
description: Use maxforge to generate, validate, compile, decompile, or clipboard-convert Max/MSP .maxpat/.maxhelp patches from concise .maxdsl text. Use when the user wants Max patch creation, repeated/generative Max object wiring, for/if/arithmetic DSL expansion, or .maxpat JSON output without hand-editing Max JSON.
---

# maxforge

Use `maxforge` as an unofficial text-first DSL compiler for Max/MSP `.maxpat` patches. Prefer `.maxdsl` when the user wants many repeated objects or connections; generating raw `.maxpat` JSON by hand is the fallback, not the default.

## Install / run

Use the published CLI without global install:

```bash
npx maxforge@latest validate input.maxdsl
npx maxforge@latest compile input.maxdsl -o output.maxpat
```

In this repository, use the local build while developing:

```bash
npm install
npm run build
node dist/cli/index.js validate examples/voice_bank.maxdsl
node dist/cli/index.js compile examples/voice_bank.maxdsl -o voice_bank.maxpat
```

## Minimal `.maxdsl`

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

## Generative pattern

Use `for`, `if`, and `${expr}` for the repeated object creation Max is bad at doing manually:

```maxdsl
patch "Voice Bank"

dac = ezdac~ at(430, 420)

for i in 0..7 {
  osc_${i} = cycle~ ${110 + i * 27.5} at(${40 + i * 110}, 80)
  amp_${i} = *~ 0.125 at(${40 + i * 110}, 140)
  osc_${i} -> amp_${i}
  amp_${i} -> dac

  if i < 4 {
    meter_${i} = meter~ at(${40 + i * 110}, 210)
    amp_${i} -> meter_${i}
  }
}
```

## Workflow

1. Write or edit a `.maxdsl` file.
2. Run `maxforge validate` before compiling.
3. Run `maxforge compile input.maxdsl -o output.maxpat`.
4. If targeting Max clipboard paste, use `--clipboard` and pipe/copy the output.
5. For reverse engineering, use `maxforge decompile input.maxpat -o output.maxdsl`; positions round-trip via `at(x, y)`.

## Syntax reminders

- Object: `name = object args... [@attr values...] [at(x, y)]`
- Connection: `a -> b -> c`, or `src[1] -> dst[2]` for outlet/inlet indices.
- Subpatcher: `fx = p name { ... }` with `inlet`/`outlet` objects inside.
- `for i in 0..7 { ... }` is inclusive; `step` is supported.
- Expressions are numeric only: loop variables, `+ - * /`, parentheses, and comparisons.
- Inline comments are not supported; put comments on their own line.

## References in this repo

- Full DSL spec: `docs/dsl-spec.md`
- Public examples: `examples/basic_synth.maxdsl`, `examples/voice_bank.maxdsl`
- Object database used by the compiler: `data/objects.json`
