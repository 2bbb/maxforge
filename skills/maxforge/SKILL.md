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
npx maxforge@latest plan input.maxdsl --scope voices --compact -o plan.json
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
   If the DSL uses project externals or abstractions, run
   `maxforge doctor --input input.maxdsl` first.
3. Run `maxforge compile input.maxdsl -o output.maxpat`.
4. If targeting Max clipboard paste, use `--clipboard` and pipe/copy the output.
5. For reverse engineering, use `maxforge decompile input.maxpat -o output.maxdsl`; positions round-trip via `at(x, y)`.
6. For live managed patching, generate a plan with `maxforge plan` and apply it
   to the native `maxforge.sync` external. Do not invent raw thispatcher commands
   when the target contains nested patchers.
7. When MCP tools are available, prefer the dedicated `maxforge-mcp` skill.
   A normal skill-guided edit does not need a redundant `maxforge_help` call;
   use help when the compact receipt contract is unavailable, unfamiliar, or
   in recovery. List patches, select the explicit `patcherId`, and require its
   `versionCompatible` field to be true before mutation. The loaded
   `externalVersion` must exactly match
   `maxforge_status.bridge.expectedExternalVersion`; a patch path does not prove
   which external Max loaded. Inspect it, then call `maxforge_prepare_change`
   with complete `desiredDsl` once, or with retained `baseSourceRef` plus small
   half-open line edits. Review compact counts, all deletes/disconnects,
   replacements, warnings, and conflicts; apply only its one-time receipt with
   `maxforge_apply_prepared_change`. Never resend the DSL at apply time. Retain
   `sourceRef`, query bounded snippets with `maxforge_get_working_source`
   `detail: "matches"`, and request full source only for broad rewrites or
   recovery. If managed manual edits exist, use
   `maxforge_review_live_changes` to separate observed evidence from inferred
   intent. Its default summary avoids bulk raw rows/snapshot/DSL; request
   `detail: "full"` only for exact before/after evidence. Interpret related
   changes through `review.editClusters` and treat `interpretationRisks` as
   prompts rather than conclusions. Use `maxforge_get_live_edit_history` first
   when recent edit order matters; check retention/drop metadata and never
   describe the observations as Max undo actions or proven human intent. Adopt
   an accepted current baseline with its exact structure token,
   or prepare the concrete next state with `manualChanges: "merge"` and apply
   only when it reports `canApply: true`. Use `maxforge_create_patch` when
   isolation in a new Max window is required. Never treat a timeout as success;
   receipts are consumed before native mutation and cannot be retried.
   Inspection reports
   text/comments plus bounded scalar or flat-array box/patch-cord attributes;
   it intentionally omits volatile values, opaque attributes, and nested data.
   A failed apply attempts generated reverse operations but is not transactional;
   inspect before retrying even when the error says reverse operations completed.
8. Restarting a stdio frontend leaves shared broker state intact. After a broker
   restart, default schema-v1 state is migrated only when every graph can be
   serialized losslessly to schema v2; a migration error must be resolved, not
   treated as an empty baseline. If persisted state is genuinely unavailable,
   provide the previous complete DSL as `currentDsl` when Max reports an
   initialized scope. A revision hash is not a recoverable graph.

## Syntax reminders

- Object: `name = object args... [@attr values...] [at(x, y[, width, height])]`
- Escape a literal Max object-text attribute as `\@attr`; plain `@attr` is a maxforge box property.
- Connection: `a -> b -> c`, or `src[1] -> dst[2]` for outlet/inlet indices.
- Subpatcher: `fx = p name { ... }` with `inlet`/`outlet` objects inside.
- Signal subpatch ports: `inlet signal` / `outlet signal`; never invent `inlet~` or `outlet~`.
- `for i in 0..7 { ... }` is inclusive; `step` is supported.
- Expressions are numeric only: loop variables, `+ - * / %`, `! && ||`, parentheses, and comparisons.
- `if` may be followed by `} else { ... }` or a next-line `else { ... }` block.
- Expansion rejects non-finite arithmetic and is capped at 100,000 iterations per loop and 100,000 emitted lines.
- Inline comments are not supported; put comments on their own line.

## Semantic object identity

- Use semantic DSL names that describe each object's role in the patch, such as
  `carrier_oscillator`, `filter_cutoff`, or `voice_3_gain`. Do not use disposable
  names such as `obj1`, `thing`, `new_object`, or `temp`.
- A DSL name is structural identity, not a comment: maxforge stores it in the
  generated Max box ID as `name` -> `obj-name`, and decompile uses that Max box
  ID to recover the original name. Renaming it is therefore an identity change.
- When the user has not supplied names, derive them from the requested function,
  nearby object roles, signal/control flow, comments, and the vocabulary already
  used in the source patch. Use a type-only name such as `number` or `cycle` only
  when the type itself is genuinely the object's role.
- For a hand-authored `.maxpat` whose default numeric box ID carries no identity,
  decompile may use a valid Max `varname` as the DSL name. Preserve meaningful
  existing `varname` values instead of replacing them with generic labels.

## Object metadata boundaries

- Do not invent an object name by analogy or by adding/removing `~`.
- Catalog entries use fixed metadata, explicit argument rules, or
  `dynamicPorts`. For dynamic entries, a stored port count is representative,
  not a safe upper bound.
- `--allow-unknown` is a dynamic 1-inlet/1-outlet fallback. It permits explicit
  higher indices but does not prove that those ports exist.
- `defaultSize` and `category` are maxforge layout/grouping data, not official
  Cycling '74 facts.
- For project externals or reusable `.maxpat` abstractions, create a strict
  `maxforge.config.json` using `schema/config-v1.json`. CLI compile, validate,
  plan, and bundle discover it upward from the input; `--config` selects one explicitly.
  Add a unique stable `project.id` when MCP state and edit evidence must survive
  restarts; do not use a saved path, filename, or title as project/patch identity.
  For ambiguous retained history, inspect `maxforge_get_patch_history_identity`
  and require human confirmation before using
  `maxforge_resolve_patch_history_identity`. Rekey/merge affect history lookup
  only; logical forget is not secure erasure.
- Call `maxforge_erase_project_history` only after the human explicitly asks to
  delete retained evidence, all Max clients are closed, status reports zero
  connected clients, and the exact `ERASE PROJECT HISTORY <project.id>` phrase
  is available. It deletes the edit journal and identity ledger, not Max/DSL/
  config files or desired-state cache, and cannot guarantee SSD secure overwrite.
- Treat persistent history as broker-owned single-writer state. Never remove
  `writer-v1.lock` to run another broker. A replacement automatically reclaims
  a valid dead-process lease; it deliberately refuses a live or malformed lease.
- Prefer fixed port metadata backed by the external's reference/help patch.
  Use bounded `ports.mode: "arguments"` when integer initialization arguments
  deterministically control counts; it is not an arbitrary expression hook.
  Use dynamic mode only when the shape cannot be resolved statically. Use `ports: "derive"`
  for an abstraction whose root `inlet`/`outlet` boxes are authoritative. Its
  catalog name must match the existing `.maxpat` filename; the file is not
  embedded and Max still needs its directory on the search path.
- Catalog metadata does not install or probe an external, put an abstraction on
  Max's search path, or prove availability on another machine.
- When changing the catalog locally, run
  `python3 scripts/audit-object-catalog.py` against Max 9 and add a unit case for
  every `argRule` entry.
- Search metadata with `npx maxforge@latest catalog <query> --json`; an
  unfiltered call lists project declarations and `--all` includes all built-ins.
- Use `npx maxforge@latest bundle input.maxdsl -o package-directory` only when
  every referenced custom dependency has a declared package path.

## Report reproducible defects

When evidence shows a maxforge defect rather than invalid DSL, missing catalog
metadata, an expected safety rejection, or a Max limitation, search existing
issues first. If no duplicate exists and authenticated GitHub issue creation is
available, open an issue at `bbb-max-externals/maxforge`. Include maxforge/Node/OS/Max
versions as relevant, the exact invocation, a minimal reproduction, actual and
expected behavior, and bounded logs or generated evidence with secrets removed.
Link the created issue in the response. Do not file conjecture without a
reproduction. If write access is unavailable, return a ready-to-file issue body
and the repository issue URL instead of claiming it was created.

## References in this repo

- Full DSL spec: `docs/dsl-spec.md`
- Public examples: `examples/basic_synth.maxdsl`, `examples/voice_bank.maxdsl`
- Native live-sync example: `examples/max_sync/`
- MCP-to-native-Max example: `examples/mcp_bridge/`
- Managed synchronization protocol: `docs/patch-sync.md`
- MCP control and restart contract: `docs/mcp.md`
- Object database used by the compiler: `data/objects.json`
- Object evidence and limits: `docs/object-catalog.md`
- Project catalog schemas: `schema/config-v1.json`, `schema/objects-v1.json`
