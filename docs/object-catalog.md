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

## Project object catalogs

Third-party externals and reusable abstraction patchers do not belong in the
audited built-in database. Declare project-specific metadata in
`maxforge.config.json` instead:

```json
{
  "$schema": "https://2bit.jp/maxforge/schema/config-v1.json",
  "schemaVersion": 1,
  "project": {
    "id": "studio_patchset",
    "name": "Studio Patchset"
  },
  "catalogs": ["./catalogs/vendor.json"],
  "objects": [
    {
      "name": "vendor.filter~",
      "kind": "external",
      "path": "./externals/vendor.filter~.mxo",
      "ports": {
        "mode": "fixed",
        "inlets": 2,
        "outlets": ["signal", ""]
      },
      "defaultSize": [110, 22]
    }
  ],
  "abstractions": [
    {
      "name": "studio.voice",
      "path": "./patchers/studio.voice.maxpat",
      "ports": "derive"
    }
  ]
}
```

All paths are resolved relative to the file that contains them. Imported
catalogs use
[`objects-v1.json`](https://2bit.jp/maxforge/schema/objects-v1.json), cannot
contain a `catalogs` property, and are loaded before declarations in the root
configuration. The format is strict: unknown keys fail validation instead of
being silently ignored.

`project.id` is the stable namespace used by MCP persistence. It must start
with a letter or underscore and contain only letters, digits, `_`, or `-`;
`project.name` is display-only. Shared imported catalogs cannot declare a
project identity. Reusing one ID for unrelated projects merges their state and
history namespaces. Renaming an ID starts a new namespace; it is not a cache
migration.

`compile`, `validate`, `plan`, and `bundle` search upward from the input DSL for the exact
filename `maxforge.config.json`. `--config path` bypasses discovery. Use
`maxforge doctor --input path/to/input.maxdsl` or `maxforge doctor --config
path/to/config.json` to validate all declarations and referenced abstractions
before compilation. Use `maxforge catalog [query] --json` to search the
effective catalog; an unfiltered call lists project declarations, while a query
also searches built-ins. `--all` requests a complete built-in listing.

The MCP broker deliberately has no working-directory discovery because an MCP
client's process directory is often unrelated to the patch project. Set
`MAXFORGE_CONFIG` explicitly, preferably to an absolute path. `maxforge_status`
reports the effective digest and source files; `maxforge_catalog` exposes the
loaded metadata to agents. After editing configured files, call
`maxforge_reload_catalog` and verify the replacement digest; a failed reload
leaves the previous database active.

### External declarations

For a fixed-shape external, `inlets` is the exact inlet count and the length of
`outlets` is the exact outlet count. Each outlet string is saved as Max
`outlettype`; use `"signal"` for an MSP signal outlet and `""` when no more
specific type is known.

Use dynamic mode only when attributes, embedded code, runtime state, or an
argument convention that the bounded rules below cannot represent can alter
the shape:

```json
{
  "name": "vendor.router",
  "kind": "external",
  "ports": {
    "mode": "dynamic",
    "representative": { "inlets": 1, "outlets": [""] }
  }
}
```

The representative shape is serialized into generated JSON, but maxforge does
not use it as an upper connection-index bound.

When the shape is a deterministic function of initialization arguments, use
bounded argument mode instead of weakening validation with dynamic mode:

```json
{
  "name": "vendor.router~",
  "kind": "external",
  "ports": {
    "mode": "arguments",
    "representative": { "inlets": 2, "outlets": ["signal"] },
    "inlets": {
      "source": "argument",
      "index": 0,
      "offset": 1,
      "minimum": 1,
      "maximum": 64
    },
    "outlets": {
      "source": "argument-count",
      "minimum": 1,
      "outlettype": "signal"
    }
  }
}
```

`source: "argument"` reads a zero-based integer argument and requires `index`.
`source: "argument-count"` counts tokens before the first `@attribute` and
forbids `index`. The optional integer `offset` is applied before `minimum` and
`maximum` clamps. An absent or non-integer indexed argument keeps the
representative count. Outlet rules generate one uniform `outlettype` per
resolved outlet. Counts are always clamped to the hard safety range 0–4096,
even when explicit bounds are omitted. At least one of `inlets` or `outlets` is
required.

This is deliberately not an expression language and cannot execute code or
refer to environment/runtime state. Shapes that need those capabilities remain
`dynamic`.

External boxes default to `maxclass: "newobj"` and size `[80, 22]`. Set
`serialization.maxclass` or `defaultSize` only when saved-patcher evidence for
that external requires different values. `override: true` is required to
replace an earlier built-in or imported definition; accidental collisions are
errors.

`path` is optional for ordinary compilation, where the target Max installation
may already provide the external. It is required when that external is actually
used by `maxforge bundle`. Use one string for a single target, or an array to
include multiple platform artifacts (for example, `.mxo` and `.mxe64`). A macOS
`.mxo` bundle directory is copied recursively under the generated package's
`externals/` directory.

### Abstraction declarations

An abstraction declaration identifies a `.maxpat` file used by Max's search
path. The declaration name must equal the filename without `.maxpat`; maxforge
does not implement abstraction aliases or embed the referenced file in a single
generated patch. The file must exist even when ports are explicit.
`ports: "derive"` (also the default when `ports` is
omitted) reads only the abstraction's root patcher:

- root `inlet` and `outlet` boxes determine counts;
- explicit numeric `index` values determine order when present on every port
  box of that kind;
- otherwise patching position, then box ID, determines order;
- an outlet is marked `signal` when an incoming source outlet has signal
  metadata; all other outlet types are `""`.

This is static metadata extraction, not recursive compilation. If the patcher
uses an argument-dependent or dynamic convention that cannot be derived
honestly, specify `arguments` or `dynamic` ports explicitly. Inline DSL
subpatchers (`name = p child { ... }`)
remain embedded in the generated patch and require no configuration file.

### Portable package bundles

`maxforge bundle input.maxdsl -o output-package` compiles the main patch under
`patchers/`, copies every referenced declared abstraction and external to the
standard `patchers/` or `externals/` directory, follows transitive custom-object
references inside abstraction files, and writes `package-info.json`. The output
directory must be empty. A used external without `path` is rejected rather than
silently producing a non-portable package.

Every copied dependency must have a unique basename within its destination
directory. Collisions are rejected; maxforge does not silently overwrite or
rename Max-search-path resources.

The collector only follows names declared in the effective catalog. Built-in
objects are not copied, and arbitrary files loaded by object arguments or
messages are not inferred. Those assets still require explicit project-level
packaging.

### Runtime boundary

Loading a catalog proves only that its JSON and referenced `.maxpat` metadata
are readable. maxforge does **not** instantiate catalog entries as a probe:
object creation can perform I/O, allocate hardware resources, or have other
side effects. Therefore catalog membership does not prove that:

- a third-party external binary is installed for the target OS/architecture;
- an abstraction directory is in Max's search path on the Max machine;
- dependencies used inside an abstraction are available;
- the declared ports still match the installed version.

Install and test dependencies in the target Max environment. This boundary is
especially important when `maxforge-mcp` and Max run on different LAN machines.

## Evidence used

Run the local audit with:

```bash
python3 scripts/audit-object-catalog.py
```

The default source is
`/Applications/Max.app/Contents/Resources/C74`. Use `--max-root` to audit a
different Max installation. The audit currently reads:

- Max reference XML;
- object lists;
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

An `objectfile` mapping alone is not accepted as object identity evidence.
In particular, Max ships mappings for `s~` and `r~`, but the audited Max 9
installation has no reference entry or saved-patcher instance for either name.
They are therefore excluded instead of inventing port metadata for mapping-only
aliases. Use `send~` and `receive~`.

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
