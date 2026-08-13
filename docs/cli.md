# CLI guide

The `maxforge` executable provides offline DSL compilation, decompilation,
validation, catalog inspection, plan generation, and package bundling. It does
not start the MCP server; that executable is `maxforge-mcp`.

## Run without global installation

```bash
npx maxforge@latest --help
npx maxforge@latest compile input.maxdsl -o output.maxpat
```

For a repository checkout:

```bash
npm install
npm run build
node dist/cli/index.js --help
```

## Commands

### `compile`

Compile DSL to `.maxpat` JSON:

```bash
maxforge compile input.maxdsl -o output.maxpat
maxforge compile input.maxdsl --clipboard
maxforge compile input.maxdsl --allow-unknown -o output.maxpat
```

`--clipboard` writes compressed text suitable for pasting into Max.
`--allow-unknown` uses representative one-inlet/one-outlet metadata and skips
upper-bound port checks. It does not inspect Max or verify the real object.

### `decompile`

```bash
maxforge decompile input.maxpat -o output.maxdsl
```

Decompilation reconstructs supported patch structure and positions. It does not
recover the original source text or promise lossless handling of arbitrary Max
JSON. See [the DSL specification](dsl-spec.md) for the supported model.

### `from-clipboard`

Read compressed Max clipboard text from standard input:

```bash
pbpaste | maxforge from-clipboard -o output.maxdsl
```

`pbpaste` is macOS-specific. On other platforms, pipe the clipboard text or a
file into standard input.

### `validate`

```bash
maxforge validate input.maxdsl
maxforge validate input.maxdsl --config /absolute/path/maxforge.config.json
```

Validation parses and compiles without writing a patch.

### `catalog`

```bash
maxforge catalog
maxforge catalog cycle~ --json
maxforge catalog --all --limit 100 --json
maxforge catalog vendor.filter~ --config ./maxforge.config.json
```

With no query, the command lists configured project objects. A query also
searches built-in metadata. `--all` includes an unfiltered built-in listing;
`--limit` defaults to 50 and is capped at 1000.

Catalog membership is metadata, not a runtime installation probe. See
[Object catalogs](object-catalog.md).

### `doctor`

```bash
maxforge doctor --input input.maxdsl
maxforge doctor --config ./maxforge.config.json
```

`doctor` validates configured catalog sources and reads declared abstraction
patches to verify or derive port metadata.

### `plan`

Create a complete managed-patch plan:

```bash
maxforge plan desired.maxdsl --scope voices --compact -o plan.json
maxforge plan next.maxdsl \
  --scope voices \
  --current current.maxdsl \
  -o plan.json
```

`--current` accepts prior desired DSL or a scoped `.maxpat` snapshot. A plan is
desired state for one managed scope; omitted managed objects are deleted when a
consumer applies it. Read [Managed patch synchronization](patch-sync.md) before
using plans against Max.

### `bundle`

```bash
maxforge bundle input.maxdsl -o my-package
maxforge bundle input.maxdsl -o my-package --name "Studio Tools"
```

The command builds a Max package directory and copies referenced paths declared
in the project catalog. It does not discover or redistribute undeclared
dependencies automatically.

## Shared options

| Option | Meaning |
|---|---|
| `-o <file>` | Output path |
| `--config <file>` | Explicit project catalog configuration |
| `--allow-unknown` | Permit objects missing from effective metadata |
| `--clipboard` | Emit compressed Max clipboard text |
| `--scope <name>` | Managed scope for plan generation; default `default` |
| `--current <file>` | Current managed DSL or scoped `.maxpat` for diffing |
| `--compact` | Emit single-line plan JSON |
| `--input <file>` | Input used to discover configuration for `doctor` or `catalog` |
| `--name <name>` | Package title for `bundle` |
| `--all` | Include all built-in catalog entries |
| `--limit <n>` | Maximum catalog records |
| `--json` | Machine-readable catalog output |

## Project catalog discovery

`compile`, `validate`, `plan`, and `bundle` search upward from the input DSL for
`maxforge.config.json`. `doctor` and `catalog` can use `--input` for the same
discovery behavior. `--config` always selects a specific file.

Configuration can declare project externals and reusable `.maxpat`
abstractions. It describes serialization and ports; it does not install those
objects or prove that Max can load them. The schema and runtime boundary are in
[docs/object-catalog.md](object-catalog.md).
