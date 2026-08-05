# Object catalog: evidence and limits

`data/objects.json` is a compiler metadata catalog, not a replacement for the
Max Object Reference. Its job is to choose a saved `maxclass`, provide enough
port metadata to validate connections, and supply a layout size.

## Current scope

The catalog contains 321 entries:

- 320 Max object names or aliases with identity evidence in the resources
  bundled with the locally audited Max 9 application;
- the project-owned `maxforge.sync` external, verified from this repository's
  C++ source and Max reference file;
- 239 entries with a fixed base shape, 45 entries with an explicit
  argument-dependent rule, and 37 entries marked `dynamicPorts`.

These groups overlap neither each other nor the unknown-object fallback.
Catalog membership does not mean that every optional Max package is installed
on another machine.

## Evidence used

Run the local audit with:

```bash
python3 scripts/audit-object-catalog.py
```

The default source is
`/Applications/Max.app/Contents/Resources/C74`. Use `--max-root` to audit a
different Max installation. The audit currently reads:

- Max reference XML;
- object lists and object mappings;
- `interfaces/max.db.json` external, alias, and fake-object indexes;
- saved `.maxhelp`, `.maxpat`, and `.maxsnip` boxes.

Embedded Gen, Jitter Gen, and RNBO graphs are excluded. Their operators are not
ordinary Max patcher objects. `max.db.json` `internals` and `exclusions` are also
excluded as identity evidence for the same reason. This distinction is why
`selector` and `mstosamps` are not catalog entries while `selector~` and
`mstosamps~` are.

For fixed metadata, an object's own Max help patch is preferred over unrelated
saved patches. Bundled files span multiple Max versions and can retain stale
`numinlets`, `numoutlets`, or `outlettype` values. The audit therefore does not
use a global majority vote as proof of current behavior.

Two aliases, `s~` and `r~`, have mapping evidence but no direct saved-patcher
instance in the audited installation. The audit reports those as warnings
rather than pretending their saved shape was independently observed.

## Port metadata classes

### Fixed base shape

The stored `numinlets`, `numoutlets`, and `outlettype` are checked against the
preferred saved-patcher observation. This validates serialized metadata; it
does not validate every message, attribute, or runtime behavior of the object.

### Explicit argument rule

Objects such as `route`, `sel`, `matrix~`, `tapout~`, arithmetic operators, and
`sfplay~` use named rules implemented in `src/core/object-db.ts`. Unit tests must
cover every catalog entry carrying `argRule`. Quoted arguments are counted as
one argument.

### Dynamic ports

For `dynamicPorts` entries, attributes, a referenced patcher, channel settings,
embedded code, or runtime configuration can change the visible shape. The
stored shape is only a representative base value. maxforge does not reject an
explicit connection merely because its index exceeds that representative
value; Max remains the final authority when the patch is loaded.

Examples include `poly~`, `bpatcher`, `gen~`, MIDI I/O variants, and
`jit.gl.slab`.

## Deliberate non-claims

- `defaultSize` is a maxforge layout default, not an official Max object size.
- `category` is a maxforge grouping label, not Cycling '74 taxonomy.
- The catalog does not describe the complete Max API or all third-party
  externals.
- `--allow-unknown` uses a fallback shape of one inlet and one outlet. That is
  not verified metadata, so maxforge skips upper-bound range rejection for the
  unknown object's real ports.
- Signal subpatch ports are written as the real Max classes `inlet` and
  `outlet`. `signal` is maxforge DSL syntax; `inlet~` and `outlet~` are not
  emitted or accepted as Max object names.

When behavior matters beyond connection bounds, consult the Max Object
Reference and test in the target Max version. Do not infer an object name by
adding or removing `~`.
