# maxdsl Formal Specification v1.3

## 1. Overview

maxdsl is a domain-specific language for describing Max/MSP patches.
It compiles to Max patcher JSON that can be saved as `.maxpat` or `.maxhelp`.

Design principles:
- **Minimal syntax** — only describe WHAT (objects + connections), not HOW (IDs, boilerplate)
- **Strict grammar** — no ambiguity, every valid program has exactly one parse tree
- **Object database resolution** — port metadata comes from audited fixed records, explicit argument rules, or a declared dynamic shape
- **Optional position override** — `at(x, y)` pins an object to a specific coordinate; un-pinned objects use auto-layout
- **Object attributes** — `@key value` pairs set arbitrary box properties (minimum, maximum, size, etc.)
- **Macro expansion for repetition** — `for`, `if`, and `${expr}` generate repetitive object graphs before parsing

## 2. EBNF Grammar

```
program           ::= { statement } ;

statement         ::= patch_decl
                    | object_def
                    | connection
                    | for_block
                    | if_block
                    | comment
                    | blank_line ;

comment           ::= '#' , { non_newline } , NEWLINE ;
blank_line        ::= NEWLINE ;

patch_decl        ::= 'patch' , STRING , { '|' , patch_param } ;
patch_param       ::= STRING | size ;
size              ::= INTEGER , 'x' , INTEGER ;

object_def        ::= IDENT , '=' , object_text , { attribute } , [ position ] , NEWLINE ;
object_text       ::= { non_newline } , { trimmed } ;
position          ::= 'at' , '(' , INTEGER , ',' , INTEGER , ')' ;
attribute         ::= '@' , IDENT , attr_value , { attr_value } ;
attr_value        ::= NUMBER | STRING | unquoted_token ;

subpatcher_def    ::= IDENT , '=' , 'p' , IDENT , { attribute } , [ position ] , '{' , { statement } , '}' ;

connection        ::= port_ref , { '->' , port_ref } , NEWLINE ;
port_ref          ::= IDENT , [ '[' , port_spec , ']' ] ;
port_spec         ::= INTEGER , [ ':' , INTEGER ] ;
                  (* outlet_index [ : inlet_index ] *)

for_block         ::= 'for' , IDENT , 'in' , expr , '..' , expr , [ 'step' , expr ] , '{' , { statement } , '}' ;
if_block          ::= 'if' , expr , '{' , { statement } , '}' ;
interpolation     ::= '${' , expr , '}' ;
expr              ::= comparison ;
comparison        ::= additive , [ ( '==' | '!=' | '<=' | '>=' | '<' | '>' ) , additive ] ;
additive          ::= multiplicative , { ( '+' | '-' ) , multiplicative } ;
multiplicative    ::= unary , { ( '*' | '/' ) , unary } ;
unary             ::= [ '+' | '-' ] , primary ;
primary           ::= NUMBER | IDENT | '(' , expr , ')' ;

(* Terminals *)
IDENT             ::= WORD ;
STRING            ::= '"' , { char | escaped_char } , '"' ;
INTEGER           ::= DIGIT , { DIGIT } ;
NUMBER            ::= [ '-' ] , INTEGER , [ '.' , { DIGIT } ] ;
WORD              ::= ( LETTER | DIGIT | '_' ) , { LETTER | DIGIT | '_' } ;
LETTER            ::= 'a'..'z' | 'A'..'Z' ;
DIGIT             ::= '0'..'9' ;
```

## 3. Lexical Rules

### 3.1 Whitespace

- Statements are **line-delimited**. Each simple statement occupies one line; block statements (`subpatcher`, `for`, `if`) span `{ ... }`.
- Blank lines are ignored.
- Leading/trailing whitespace on a line is trimmed.
- Within a line, whitespace separates tokens.

### 3.2 Comments

```
# This is a comment
osc = cycle~ 440
# inline comments after a statement are not supported
```

- A line starting with `#` (after optional whitespace) is a comment.
- Comments are stripped before parsing.
- Inline comments (after a statement) are **NOT supported**.

### 3.3 Identifiers (IDENT)

```
IDENT ::= ( a-z | A-Z | 0-9 | _ )+
```

- Current parser accepts letters, digits, and underscores, including a digit as the first character.
- For portable output and readable decompilation, prefer starting names with a letter or underscore.
- Case-sensitive.
- Used for: object names (LHS of `=`), connection references.

Examples: `osc`, `freq`, `gain_left`, `_temp`, `myFilter`

### 3.4 Strings

```
STRING ::= '"' ... '"'
```

- Delimited by double quotes.
- Escaped quotes are recognized while tokenizing quoted values.
- `comment` and `message` text unescape `\"` and `\\`.
- `\n` is not interpreted as a newline escape.
- Used in: `patch` declaration, `comment` text, `message` text, and quoted attribute values.

### 3.5 Arrow Operator

```
ARROW ::= '-' , '>'
```

- Separator in connection statements.
- Whitespace around `->` is optional in the current parser, but `a -> b` is the recommended style.

### 3.6 Port Specifiers

```
port_spec ::= '[' INTEGER [ ':' INTEGER ] ']'
```

- `[N]` — outlet N (inlet defaults to 0)
- `[N:M]` — outlet N → inlet M
- No spaces inside brackets: `a[1]` (not `a[ 1 ]`)
- Indices are **0-based** (left-most = 0)

### 3.7 Position Specifier

```
position ::= 'at' '(' INTEGER ',' INTEGER ')'
```

- Appears at the end of an object definition line.
- `x` and `y` are pixel coordinates in the Max patching rect.
- Spaces around the numbers and comma are allowed: `at(100,200)`, `at(100, 200)`, `at( 100, 200 )`.
- If present, auto-layout is skipped for this object.

### 3.8 Attributes

```
attribute ::= '@' IDENT attr_value { attr_value }
attr_value ::= NUMBER | STRING | unquoted_token
```

- `@key value` pairs appear between the object text and the optional `at(x, y)`.
- Each `@` token starts a new attribute; values are consumed until the next `@` or `at(` or end of line.
- Single-value attributes emit a scalar in the box JSON; multi-value emit an array.
- String values can be quoted (`"Courier"`) or unquoted (`Arial`).
- Numeric values are parsed as numbers; everything else is a string.
- Prefix an object argument with `\` when the literal token must begin with
  `@`. For example, `maxforge.sync \@host 127.0.0.1` emits the object text
  `maxforge.sync @host 127.0.0.1` instead of a `host` box JSON key.
- The decompiler adds this escape to literal `@` tokens in `newobj` text so
  compile/decompile round-trips preserve Max initialization arguments.

Examples:

| DSL | Box JSON key | Value |
|-----|-------------|-------|
| `@minimum 0` | `minimum` | `0` |
| `@maximum 127` | `maximum` | `127` |
| `@size 20 100` | `size` | `[20, 100]` |
| `@fontname "Courier"` | `fontname` | `"Courier"` |
| `@triangle 0` | `triangle` | `0` |

Full object definition with attributes:

```maxdsl
freq = number @minimum 0 @maximum 127 at(100, 50)
vol = slider @size 20 140 @min 0 @max 100
```

The decompiler reverses this: any non-structural box key in a box JSON is emitted as `@key value`.

Reserved structural keys cannot be set with attributes: `id`, `maxclass`, `numinlets`, `numoutlets`, `outlettype`, `patching_rect`, `text`, `patcher`, and `comment`.

### 3.9 Control-flow and arithmetic expansion

Control-flow is expanded before normal DSL parsing. It is intentionally a macro system, not a runtime feature in Max.

#### Interpolation

```
${expr}
```

`${expr}` can appear inside object names, object arguments, attributes, positions, and connections. Expressions support:

- numbers and loop variables
- `+`, `-`, `*`, `/`
- parentheses
- comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`

Examples:

```maxdsl
osc_${i} = cycle~ ${220 + i * 10} at(${50 + i * 120}, 100)
slider_${i} = slider @size ${20} ${80 + i * 10}
```

#### For loop

```
for i in 0..7 {
  osc_${i} = cycle~ ${220 + i * 20}
}
```

- Ranges are inclusive: `0..7` emits 8 iterations.
- Descending ranges are allowed: `3..0`.
- Optional `step` is supported: `for i in 0..6 step 2`.
- `step 0` is a syntax error.

#### If block

```
for i in 0..7 {
  if i < 4 {
    left_${i} = *~ 0.25
  }
}
```

The block is emitted when the expression is non-zero. Comparisons return `1` for true and `0` for false.

## 4. Statement Semantics

### 4.1 Patch Declaration

```
patch "Patch Name"
patch "Patch Name" | "Description text"
patch "Patch Name" | "Description text" | 800x600
```

- **Optional**. If omitted, defaults to `"Untitled" | "" | 640x480`.
- Recommended position is before any object definitions or connections.
- Use at most one `patch` declaration. If multiple declarations are present, the current parser keeps the last one; do not rely on this.
- Parameters after `|`:
  1. Description (string)
  2. Window size (`WIDTHxHEIGHT`)

### 4.2 Object Definition

```
name = type [args...] [@attr val ...] [at(x, y)]
```

- `name` — IDENT, must be unique within the current scope (patcher/subpatcher).
- `=` — literal equals sign.
- Everything after `=` (trimmed, excluding the optional attributes and `at(...)` suffix) is the **object text**.
- The first token of the object text is resolved against the object database.
- Generated box IDs are derived from the DSL name (`name` → `obj-name`) and stay
  stable when unrelated statements are inserted or reordered.
- Attributes are emitted as box JSON keys after structural keys are generated. Reserved structural keys are rejected.
- `at(x, y)` — **Optional** position override. Pins the object to coordinate `(x, y)`. Objects without `at()` are positioned by auto-layout.

When compiling to a managed patch graph, `@varname` is additionally reserved.
The synchronization layer assigns a scope-owned scripting name for identity and
ownership tracking.

**Object text examples:**

| DSL | maxclass | text field |
|-----|----------|------------|
| `osc = cycle~ 440` | `newobj` | `cycle~ 440` |
| `mul = *~ 0.5` | `newobj` | `*~ 0.5` |
| `freq = number` | `number` | *(none)* |
| `dac = ezdac~` | `ezdac~` | *(none)* |
| `c = comment "Hello"` | `comment` | `Hello` |
| `m = message "open"` | `message` | `open` |
| `dly = tapin~ 1000` | `newobj` | `tapin~ 1000` |
| `filt = lores~ 1000 0.5` | `newobj` | `lores~ 1000 0.5` |

**Special object types with text extraction rules:**

| First token | maxclass | text handling |
|-------------|----------|---------------|
| `comment` | `comment` | text = content inside `""` |
| `message` | `message` | text = content inside `""` |
| Database object with `maxclass: "newobj"` | `newobj` | text = object text |
| Unknown object with `--allow-unknown` | `newobj` | text = object text |
| `toggle`, `number`, `flonum`, etc. | same as token | no text field |

### 4.3 Subpatcher Definition

```
name = p subpatcher_name [@attr value...] [at(x, y)] {
  ...statements...
}
```

- `name` — IDENT, unique in current scope.
- `p` — literal keyword.
- `subpatcher_name` — IDENT, used in the Max text field as `p subpatcher_name`.
- Attributes after `subpatcher_name` apply to the parent subpatcher box.
- `at(x, y)` pins the parent subpatcher box position.
- `{ }` — contains inner statements (objects, connections, nested subpatchers).
- `numinlets` / `numoutlets` are auto-derived from the count of `inlet`/`outlet` objects inside.
- Inner object IDs are independently numbered (scoped).
- `inlet` and `outlet` are only valid inside subpatchers.
- The optional `signal` modifier marks a signal port without inventing a Max
  object class. Both `inlet signal` and `outlet signal` serialize with the real
  `maxclass` values `inlet` and `outlet`.

**Example:**

```
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

Compiles to:
```json
{
  "box": {
    "id": "obj-N",
    "maxclass": "newobj",
    "numinlets": 1,
    "numoutlets": 1,
    "outlettype": ["signal"],
    "text": "p delay_fx",
    "patcher": { ... }
  }
}
```

### 4.4 Connection

```
name -> name
name -> name -> name -> name
name[1] -> name
name[1:2] -> name
```

- Chain syntax: `a -> b -> c` is equivalent to `a -> b` + `b -> c`.
- Each `->` creates ONE patchline.
- Port defaults: outlet=0, inlet=0.
- `[N]` = outlet N → inlet 0.
- `[N:M]` = outlet N → inlet M.

**Validation rules (enforced at compile time):**
1. Every name in a connection must reference a defined object.
2. For a non-dynamic source, outlet index must be < source object's `numoutlets`.
3. For a non-dynamic destination, inlet index must be < destination object's `numinlets`.
4. Duplicate connections (same source+outlet, same dest+inlet) are ignored with a warning.
5. Connections are resolved in source order, so objects must be defined before a connection that references them.

### 4.5 Implicit Objects

The following are recognized by the first token and have special handling:

| DSL form | Max `maxclass` | Notes |
|----------|----------------|-------|
| `inlet` | `inlet` | numinlets=0, numoutlets=1. Subpatcher only. |
| `inlet signal` | `inlet` | Same Max object with outlettype=["signal"]. |
| `outlet` | `outlet` | numinlets=1, numoutlets=0. Subpatcher only. |
| `outlet signal` | `outlet` | Same Max object; marks the matching parent outlet as signal. |

For these, an optional STRING after the type or `signal` modifier is the `comment` field:
```
in_audio = inlet signal "audio input"
```

## 5. Object Database Resolution

### 5.1 Lookup

When the compiler encounters `name = type_text`, it:
1. Extracts the first token (delimited by whitespace) as the **object type key**.
2. Looks up the key in the object database.
3. Resolves `maxclass`, port metadata, and layout size from one of three
   catalog classes: fixed, argument-dependent, or dynamic.

The bundled catalog contains 321 entries: 320 Max object names or aliases with
identity evidence in the locally audited Max 9 resources, plus the project-owned
`maxforge.sync` external. This is not a complete Max API. Catalog membership is
also not a claim that an optional package is installed on every Max system.

The exact evidence hierarchy, generated-metadata limits, dynamic-port behavior,
and known identity-only alias warnings are documented in
[`object-catalog.md`](object-catalog.md).

### 5.2 Argument-dependent inlets/outlets

Some objects have inlet/outlet counts that depend on arguments:

| Object | Rule |
|--------|------|
| `gate` | outlets = first arg value |
| `switch` | inlets = first arg value + 1 |
| `route` | inlets = outlets = arg count + 1 in current Max 9 saved patches |
| `sel` | inlets = outlets = arg count + 1; matched outlets are bang |
| `pack` | inlets = arg count |
| `unpack` | outlets = arg count |
| `selector~` | inlets = first arg value + 1 |
| `matrix~` | inlets = first arg; signal outlets = second arg; plus one status outlet |
| `gate~` | outlets = first arg value |
| `tapout~` | one inlet/outlet signal pair per delay argument |
| `adc~` / `dac~` | signal outlets/inlets = channel argument count |

These are handled by named rules in `src/core/object-db.ts`. Quoted arguments
count as one argument. Every catalog entry carrying `argRule` has a unit-test
case; the table above is only representative.

### 5.3 Dynamic ports

Some objects derive their shape from attributes, embedded code, channel
settings, a referenced patcher, or runtime configuration. Their catalog record
uses `dynamicPorts: true` and stores only a representative base shape. The
compiler does not reject an explicit index above that representative bound.
Examples include `poly~`, `bpatcher`, `gen~`, and `jit.gl.slab`.

### 5.4 Unknown objects

If an object type is NOT found in the database:
- **Error by default** — compilation fails.
- **`--allow-unknown` flag** — creates a dynamic `newobj` with representative
  `numinlets=1`, `numoutlets=1`, `outlettype=[""]` metadata. Upper-bound index
  rejection is skipped because the real shape is unknown.

## 6. Auto-Layout Algorithm

### 6.1 Rules

1. Extract connection graph from all connection statements.
2. Compute levels using a simple topological traversal from objects with zero incoming edges.
3. Assign Y-coordinates by level:
   - Level 0: Y = 50
   - Each later level: Y += 60
4. Assign X-coordinates within each level:
   - First object in a level: X = 50
   - Each additional object in the same level: X += 150
5. Width/height from object database defaults.

### 6.2 Feedback loops

There is no special feedback routing. Nodes left unvisited by the topological traversal are placed in later levels in declaration order. Patchlines are emitted without midpoints.

### 6.3 Manual override

Objects with `at(x, y)` are **pinned** to the specified coordinates. Auto-layout skips pinned objects and positions only un-pinned ones.

```maxdsl
# pinned at (50, 30)
cmt = comment "Title" at(50, 30)

# auto-layout
osc = cycle~ 440

# pinned at (50, 300)
dac = ezdac~ at(50, 300)
```

The decompiler emits `at(x, y)` from the first two values of `patching_rect` so positions survive decompile/recompile. Width and height are still derived from the object database/defaults; they are not represented in DSL syntax.

## 7. Output Format

### 7.1 JSON structure

The compiler outputs a JSON object matching the Max `.maxpat` format:
- `fileversion`: 1
- `appversion`: `{ major: 9, minor: 0, revision: 0, architecture: "x64", modernui: 1 }`
- IDs: `"obj-1"`, `"obj-2"`, ... (sequential per scope)
- 2-space indentation
- UTF-8, LF line endings
- Box keys are generated in compiler order: structural fields first, then optional fields such as `outlettype`, `text`, `comment`, `patcher`, and attributes.

### 7.2 File extension

- Output: `.maxpat` (standard patch) or `.maxhelp` (help patch)
- Input: `.maxdsl`

## 8. Error Handling

### 8.1 Compile-time errors (fatal)

| Code | Message | Cause |
|------|---------|-------|
| E001 | `Duplicate name: "{name}"` | Two objects with the same IDENT |
| E002 | `Undefined reference: "{name}"` | Connection references non-existent object |
| E003 | `Unknown object type: "{type}"` | Object type not in database |
| E004 | `Outlet index out of range: {name}[{idx}] has {max} outlets` | Port spec exceeds numoutlets |
| E005 | `Inlet index out of range: {name}[{idx}] has {max} inlets` | Port spec exceeds numinlets |
| E006 | `inlet/outlet outside subpatcher` | inlet/outlet used at top level |
| E007 | `Syntax error at line {N}: {detail}` | Malformed statement |
| E008 | `Subpatcher "{name}" has no inlets or outlets` | Empty subpatcher with no inlet/outlet objects |
| E009 | `Reserved attribute cannot be set with @{key}` | Attribute would corrupt structural box JSON |

### 8.2 Warnings (non-fatal)

| Code | Message |
|------|---------|
| W001 | `Duplicate connection: {src}[{out}] -> {dst}[{in}]` |

`W002` exists in the TypeScript enum but is not currently emitted.

## 9. Complete Example

```
patch "Basic Synth" | "Simple oscillator -> gain -> DAC" | 640x480

cmt = comment "Basic Synth: number -> mtof -> cycle~ -> *~ -> gain~ -> ezdac~"
freq = number
mt = mtof
osc = cycle~ 440
mul = *~ 0.5
vol = gain~
dac = ezdac~

freq -> mt -> osc -> mul -> vol -> dac
vol[1] -> dac[1]
```

Compiles to 7 boxes + 7 lines with auto-layout.
