# maxdsl Formal Specification v1.1

## 1. Overview

maxdsl is a domain-specific language for describing Max/MSP patches.
It compiles to `.maxpat` / `.maxhelp` JSON files.

Design principles:
- **Minimal syntax** — only describe WHAT (objects + connections), not HOW (IDs, boilerplate)
- **Strict grammar** — no ambiguity, every valid program has exactly one parse tree
- **Object database resolution** — `numinlets`, `numoutlets`, `outlettype` are auto-derived
- **Optional position override** — `at(x, y)` pins an object to a specific coordinate; un-pinned objects use auto-layout

## 2. EBNF Grammar

```
program           ::= { statement } ;

statement         ::= patch_decl
                    | object_def
                    | connection
                    | comment
                    | blank_line ;

comment           ::= '#' , { non_newline } , NEWLINE ;
blank_line        ::= NEWLINE ;

patch_decl        ::= 'patch' , STRING , { '|' , patch_param } ;
patch_param       ::= STRING | size ;
size              ::= INTEGER , 'x' , INTEGER ;

object_def        ::= IDENT , '=' , object_text , [ position ] , NEWLINE ;
object_text       ::= { non_newline } , { trimmed } ;
position          ::= 'at' , '(' , INTEGER , ',' , INTEGER , ')' ;

subpatcher_def    ::= IDENT , '=' , 'p' , IDENT , '{' , { statement } , '}' ;

connection        ::= port_ref , { '->' , port_ref } , NEWLINE ;
port_ref          ::= IDENT , [ '[' , port_spec , ']' ] ;
port_spec         ::= INTEGER , [ ':' , INTEGER ] ;
                  (* outlet_index [ : inlet_index ] *)

(* Terminals *)
IDENT             ::= ( LETTER | '_' ) , { LETTER | DIGIT | '_' } ;
STRING            ::= '"' , { char | escaped_char } , '"' ;
INTEGER           ::= DIGIT , { DIGIT } ;
NUMBER            ::= [ '-' ] , INTEGER , [ '.' , { DIGIT } ] ;
LETTER            ::= 'a'..'z' | 'A'..'Z' ;
DIGIT             ::= '0'..'9' ;
```

## 3. Lexical Rules

### 3.1 Whitespace

- Statements are **line-delimited**. Each statement occupies one line (except subpatcher `{ ... }`).
- Blank lines are ignored.
- Leading/trailing whitespace on a line is trimmed.
- Within a line, whitespace separates tokens.

### 3.2 Comments

```
# This is a comment
osc = cycle~ 440  # inline comments NOT supported in v1
```

- A line starting with `#` (after optional whitespace) is a comment.
- Comments are stripped before parsing.
- Inline comments (after a statement) are **NOT supported** in v1.

### 3.3 Identifiers (IDENT)

```
IDENT ::= ( a-z | A-Z | _ ) ( a-z | A-Z | 0-9 | _ )*
```

- Must start with a letter or underscore.
- Case-sensitive.
- Used for: object names (LHS of `=`), connection references.

Examples: `osc`, `freq`, `gain_left`, `_temp`, `myFilter`

### 3.4 Strings

```
STRING ::= '"' ... '"'
```

- Delimited by double quotes.
- Escape sequences: `\"` → `"`, `\\` → `\`, `\n` → newline.
- Used in: `patch` declaration, `comment` text, `message` text.

### 3.5 Arrow Operator

```
ARROW ::= '-' , '>'
```

- Separator in connection statements.
- Must be surrounded by whitespace: `a -> b` (not `a->b`).

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
- No spaces inside parentheses: `at(100,200)` or `at(100, 200)`.
- If present, auto-layout is skipped for this object.

## 4. Statement Semantics

### 4.1 Patch Declaration

```
patch "Patch Name"
patch "Patch Name" | "Description text"
patch "Patch Name" | "Description text" | 800x600
```

- **Optional**. If omitted, defaults to `"Untitled" | "" | 640x480`.
- Must appear **before** any object definitions or connections.
- Only ONE `patch` declaration per file (or per subpatcher).
- Parameters after `|`:
  1. Description (string)
  2. Window size (`WIDTHxHEIGHT`)

### 4.2 Object Definition

```
name = type [args...] [@attr val ...] [at(x, y)]
```

- `name` — IDENT, must be unique within the current scope (patcher/subpatcher).
- `=` — literal equals sign.
- Everything after `=` (trimmed, excluding the optional `at(...)` suffix) is the **object text**.
- The first token of the object text is resolved against the object database.
- `at(x, y)` — **Optional** position override. Pins the object to coordinate `(x, y)`. Objects without `at()` are positioned by auto-layout.

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
| Anything else with `~` | `newobj` | text = full line after `=` |
| Anything else | `newobj` | text = full line after `=` |
| `toggle`, `number`, `flonum`, etc. | same as token | no text field |

### 4.3 Subpatcher Definition

```
name = p subpatcher_name {
  ...statements...
}
```

- `name` — IDENT, unique in current scope.
- `p` — literal keyword.
- `subpatcher_name` — IDENT, used in the Max text field as `p subpatcher_name`.
- `{ }` — contains inner statements (objects, connections, nested subpatchers).
- `numinlets` / `numoutlets` are auto-derived from the count of `inlet`/`outlet` objects inside.
- Inner object IDs are independently numbered (scoped).
- `inlet`, `inlet~`, `outlet`, `outlet~` are only valid inside subpatchers.

**Example:**

```
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
2. Outlet index must be < source object's `numoutlets`.
3. Inlet index must be < destination object's `numinlets`.
4. Duplicate connections (same source+outlet, same dest+inlet) are ignored with a warning.

### 4.5 Implicit Objects

The following are recognized by the first token and have special handling:

| First token | maxclass | Notes |
|-------------|----------|-------|
| `inlet` | `inlet` | numinlets=0, numoutlets=1. Subpatcher only. |
| `inlet~` | `inlet~` | numinlets=0, numoutlets=1, outlettype=["signal"]. Subpatcher only. |
| `outlet` | `outlet` | numinlets=1, numoutlets=0. Subpatcher only. |
| `outlet~` | `outlet~` | numinlets=1, numoutlets=0. Subpatcher only. |

For these, optional STRING after the type is the `comment` field:
```
in_audio = inlet~ "audio input"
```

## 5. Object Database Resolution

### 5.1 Lookup

When the compiler encounters `name = type_text`, it:
1. Extracts the first token (delimited by whitespace) as the **object type key**.
2. Looks up the key in the object database.
3. Resolves: `maxclass`, `numinlets`, `numoutlets`, `outlettype`, `default_size`.

### 5.2 Argument-dependent inlets/outlets

Some objects have inlet/outlet counts that depend on arguments:

| Object | Rule |
|--------|------|
| `gate` | outlets = first arg value |
| `switch` | inlets = first arg value + 1 |
| `route` | outlets = arg count + 1 |
| `pack` | inlets = arg count |
| `unpack` | outlets = arg count |
| `selector~` | inlets = first arg value + 1 |
| `matrix~` | inlets = first arg, outlets = second arg |
| `gate~` | outlets = first arg value |

These are handled by special-case logic in the compiler.

### 5.3 Unknown objects

If an object type is NOT found in the database:
- **Error by default** — compilation fails.
- **`--allow-unknown` flag** — creates the object with `numinlets=1, numoutlets=1, outlettype=[""]` as a fallback.

## 6. Auto-Layout Algorithm

### 6.1 Rules

1. Extract connection graph from all connection statements.
2. Perform topological sort (respecting connection direction: source → destination).
3. Assign Y-coordinates based on topological order:
   - First object: Y = 50
   - Each subsequent: Y += 60
4. Assign X-coordinates:
   - Objects in the main chain: X = 50
   - Branches (objects with multiple destinations or feedback): X += 120
5. Width/height from object database defaults.

### 6.2 Feedback loops

If the graph contains cycles (feedback):
- Detect cycle edges.
- Route feedback connections with a right-offset (X += 240) and midpoint routing.

### 6.3 Manual override

Objects with `at(x, y)` are **pinned** to the specified coordinates. Auto-layout skips pinned objects and positions only un-pinned ones.

```
cmt = comment "Title" at(50, 30)     # pinned at (50, 30)
osc = cycle~ 440                      # auto-layout
dac = ezdac~ at(50, 300)              # pinned at (50, 300)
```

Decompiled output always includes `at(x, y)` so that round-tripping preserves positions.

## 7. Output Format

### 7.1 JSON structure

The compiler outputs a JSON object matching the Max `.maxpat` format:
- `fileversion`: 1
- `appversion`: `{ major: 8, minor: 6, revision: 4 }`
- IDs: `"obj-1"`, `"obj-2"`, ... (sequential per scope)
- 2-space indentation
- UTF-8, LF line endings
- Keys ordered: `id`, `maxclass`, `numinlets`, `numoutlets`, `outlettype`, `patching_rect`, `text`, ...

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

### 8.2 Warnings (non-fatal)

| Code | Message |
|------|---------|
| W001 | `Duplicate connection: {src}[{out}] -> {dst}[{in}]` |
| W002 | `Unconnected object: "{name}"` |
| W003 | `Object "{name}" has no outgoing connections and no UI purpose` |

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
