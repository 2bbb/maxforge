# maxforge / maxdsl — AI Agent Guide

Max/MSPパッチを記述する非公式DSL。生JSONの代わりにコンパクトなテキストで記述し、`maxforge` CLIで `.maxpat` に変換する。

## Trigger

ユーザーがMaxパッチの生成・作成を要求したとき。`.maxdsl` ファイルを書いてコンパイルする。

## Quick Start

```
# 例: basic_synth.maxdsl

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

```bash
npm run build
node dist/cli/index.js compile basic_synth.maxdsl -o basic_synth.maxpat
```

## Syntax Reference

### Comments

```
# 行頭の # はコメント。インラインコメントは不可。
```

### Patch Declaration (省略可)

```
patch "Title"
patch "Title" | "Description"
patch "Title" | "Description" | 800x600
```

省略時: `"Untitled" | "" | 640x480`

### Object Definition

```
name = type [args...] [@attr val ...] [at(x, y)]
```

- `name` — 英字/アンダースコア始まりの識別子。スコープ内で一意。
- `=` 以降がMaxのtextフィールドになる。
- `numinlets`/`numoutlets`/`outlettype` は、監査済み固定値・引数ルール・dynamic markerのいずれかで解決する。DSLに直接書かない。
- `@attr val` — **省略可**の属性指定。box JSONに直接出力される。
- newobjの`text`にMax attributeを残す場合は`\@attr`と書く。未escapeの`@attr`はbox JSON propertyとして解釈される。
- `at(x, y)` — **省略可**の座標指定。指定するとauto-layoutを上書き。省略時は自動配置。

**属性の書き方:**

```
# range指定
freq = number @minimum 0 @maximum 127

# 複数値は配列になる
vol = slider @size 20 140 @min 0 @max 100

# 文字列値
num = flonum @fontname "Courier"

# 数値
tog = toggle @triangle 0
```

- 単一値 → box JSONのスカラー (`"minimum": 0`)
- 複数値 → box JSONの配列 (`"size": [20, 140]`)
- 文字列値は `"` で囲むか、英数字のみならそのまま
- デコンパイル時、構造キー以外はすべて `@key value` として復元される
- `id`, `maxclass`, `numinlets`, `numoutlets`, `outlettype`, `patching_rect`, `text`, `patcher`, `comment` は予約キーなので `@` では指定不可

**書き方の一覧:**

```
# 一般オブジェクト (maxclass: newobj)
osc = cycle~ 440
mul = *~ 0.5
mt = mtof
filt = lores~ 1000 0.5
metro = metro 500 @active 1

# UI部品 (maxclass = オブジェクト名)
freq = number
vol = flonum
tog = toggle
btn = button
sld = slider
dac = ezdac~
gn = gain~
mtr = meter~

# コメント (maxclass: comment)
cmt = comment "説明テキスト"

# メッセージ (maxclass: message)
msg = message "open"
msg2 = message "start 500"

# send/receive
sender = send mybus
recv = receive mybus

# 座標指定（省略可）
cmt = comment "Title" at(50, 30)
osc = cycle~ 440 at(100, 100)
```

### for / if / 四則演算

Max が苦手な「大量の類似オブジェクト生成」は `for` と `${expr}` で書く。
これは Max の実行時制御ではなく、`.maxdsl` のコンパイル前展開。

```
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

- `for i in 0..7` は **両端含む** ので 8 回展開。
- `step` 指定可: `for i in 0..6 step 2`
- `${expr}` は名前、引数、属性、座標、接続のどこでも使用可能。
- 式は数値、ループ変数、`+ - * /`、括弧、比較演算 `== != < <= > >=` をサポート。
- `if expr { ... }` は式が `0` 以外なら展開。比較は true=`1`, false=`0`。

### Connections

```
# 直列 (outlet 0 → inlet 0)
a -> b -> c -> d

# 個別ポート指定 [outlet_index] または [outlet_index:inlet_index]
# vol の outlet 1 → dac の inlet 1
vol[1] -> dac[1]

# src の outlet 0 → dst の inlet 1
src[0] -> dst[1]

# ポート番号は 0-indexed（左端 = 0）
```

**注意事項:**
- 接続先のオブジェクトは**先に定義**されている必要がある。
- 固定形状または引数解決済みオブジェクトのoutlet/inlet範囲はコンパイル時に検証される。`dynamicPorts`と`--allow-unknown`は根拠のない上限判定を行わない。
- 同じ接続の重複は警告のみ（エラーではない）。

### Subpatcher

```
fx = p delay_fx at(200, 300) {
  in = inlet signal "audio in"
  out = outlet signal "audio out"
  buf = tapin~ 500
  tap = tapout~ 250
  fb = *~ 0.4

  in -> buf -> tap -> fb -> buf
  tap -> out
}
```

- Maxオブジェクトとして存在するのは `inlet` / `outlet` のみで、**サブパッチャー内でのみ使用可能**。
- 信号ポートはmaxforgeの修飾子 `signal` を付けて `inlet signal` / `outlet signal` と書く。生成される `maxclass` は実在する `inlet` / `outlet` のまま。
- 親から見た `numinlets` / `numoutlets` は内部の inlet/outlet 数から自動計算。
- `at(x, y)` は親側の subpatcher box の位置指定。
- 内部のオブジェクトIDはDSL名から決まり、同じスコープ内で安定する。
- ネスト可能（subpatcher内にsubpatcher）。

### Managed patch synchronization

agents が同じパッチ領域を継続的に更新する場合は、`thispatcher` の全生成コマンドではなく
desired graph APIを使う。

```js
const desired = compileDslToPatchGraph(source, database, "voices");
const plan = diffPatchGraphs(currentGraph, desired.graph);
```

CLIでは同じplanを直接生成できる。

```bash
maxforge plan desired.maxdsl --scope voices --compact -o plan.json
maxforge plan next.maxdsl --scope voices --current current.maxdsl -o plan.json
```

- `scope` は英字またはアンダースコアで始まる識別子にする。
- managed graphでは`@varname`を指定しない。`maxforge_<scope>_obj_...`の形式で自動管理される。
- `baseRevision`が現在のrevisionと一致しないplanは適用しない。
- managed scope外のオブジェクトを削除・変更しない。
- DSLはdesired stateとして扱い、`delete`などの命令型構文を追加しない。
- Max内では`maxforge.sync @scope voices`へ`apply <compact-json>`を送るか、
  named `dict`を`applydict <name>`で適用する。
- `maxforge.sync`はJavaScriptや`thispatcher`を経由せずMax SDKでpatcherを変更する。
- protocol v1はruntime failure時のrollbackを保証しない。
- 詳細は`docs/patch-sync.md`を参照。

### MCP経由のlive managed patch

MCPクライアントからMaxを変更する場合は、次の順序を崩さない。

1. 初回操作では`maxforge_help`へ`topic: "workflow"`を渡し、serverが返す
   最新の操作規約を読む。失敗後は`topic: "recovery"`を読む。
2. `maxforge_list_patches`で登録済み`patcherId`とscopeを確認する。
3. 別ウィンドウが必要なら`maxforge_create_patch`で一意な`patcherId`、
   scope、titleを指定し、登録完了まで待つ。
4. `maxforge_inspect_patch`で対象`patcherId`のlive状態を読む。
5. managed manual changeがあれば、完全なdesired DSLを
   `maxforge_reconcile_patch`へ渡す。`canApply: true`でなければ適用しない。
6. 通常経路では`maxforge_compile_plan`、手動変更の統合経路ではreconcileが
   返したplanを確認する。
7. `maxforge_apply_dsl`へ同じ対象と完全なdesired DSLを渡す。reconcile済みの
   場合だけ`manualChanges: "merge"`を指定する。
8. `maxforge.applied` acknowledgementのrevisionがtargetRevisionと一致した
   結果だけを成功扱いする。
9. 再度inspectし、期待したbox/cord数とmanaged差分を確認する。

MCPプロセス再起動後、Max側のscopeが初期化済みなら、以前の完全なDSLを
`currentDsl`として一度渡す。revision hashだけから現在graphを推測してはいけない。

managed manual changeをinspectしただけではbaselineは更新されない。
`maxforge_reconcile_patch`は前回graph・live snapshot・次のdesired DSLを三者比較し、
非競合変更だけを保持する。同一fieldの競合やchange-vs-deleteは明示的に解消する。
apply側は再inspectした構造tokenをplanへ埋め込み、native externalが変更直前に
再照合する。その間にboxまたはcordが変わった場合は上書きせず拒否される。
timeout、transport error、`baselineCaptured: false`を理由に
同じapplyを即時再送してはいけない。statusとlive inspectを先に行う。

Max側は`examples/mcp_bridge/`の通り、接続設定を持つnative
`maxforge.sync`を1個だけ置く。接続、再接続、登録、request/eventの
送受信はexternal内部で完結し、bootstrap用のpatch cordは不要。
複数パッチをタイトルで推測せず、必ず`patcherId`で指定する。Max内で
JavaScriptを追加したり、agentに生の`thispatcher`コマンドを生成させたり
しない。

live操作を継続的にagentへ任せる場合は、汎用DSL skillとは別に安全規約を持つ
専用skillを導入する。

```bash
npx skills add 2bbb/maxforge --skill maxforge-mcp
```

skillはagentへのinstructionsであり、`maxforge-mcp` serverやnative externalを
インストールするものではない。

詳細は`docs/mcp.md`を参照。

### Full Example: MIDI Synth

```
patch "MIDI Synth" | "MIDI note -> oscillator -> envelope -> DAC"

cmt = comment "MIDI Synth: notein -> midiparse -> mtof -> cycle~ -> *~ -> gain~ -> ezdac~"

note = notein
parse = midiparse
mtof_obj = mtof
osc = cycle~ 440
env = line~
mul = *~
vol = gain~
dac = ezdac~

# pitch path
note -> parse
parse -> mtof_obj -> osc -> mul -> vol -> dac
vol[1] -> dac[1]

# velocity -> envelope -> amplitude
parse[1] -> env
parse[2] -> env[1]
env -> mul[1]
```

## Object Reference

### 振り分け

| カテゴリ | 代表オブジェクト |
|----------|-----------------|
| オーディオ(MSP) | `cycle~`, `phasor~`, `*~`, `+~`, `lores~`, `tapin~`, `tapout~`, `ezdac~`, `gain~` |
| MIDI | `notein`, `noteout`, `ctlin`, `midiparse`, `mtof` |
| Jitter | `jit.movie`, `jit.window`, `jit.op`, `jit.matrix` |
| ロジック | `gate`, `route`, `sel`, `metro`, `counter`, `random`, `delay`, `pipe` |
| データ | `pack`, `unpack`, `prepend`, `append`, `coll`, `dict`, `table` |
| 数学 | `+`, `-`, `*`, `/`, `expr`, `scale`, `random` |
| 通信 | `send`, `receive`, `udpsend`, `udpreceive` |
| UI | `number`, `flonum`, `toggle`, `button`, `slider`, `umenu`, `message`, `comment` |
| サブパッチャー | `p name { ... }`, `inlet`, `outlet`, `inlet signal`, `outlet signal` |

### 引数でinlet/outlet数が変わるオブジェクト

| オブジェクト | ルール |
|-------------|--------|
| `gate N` | outlets = N |
| `route a b c` | current Max 9 saved patchではinlets = outlets = 引数の数 + 1 |
| `sel a b c` | inlets = outlets = 引数の数 + 1、match側はbang |
| `pack a b c` | inlets = 引数の数 |
| `unpack a b c` | outlets = 引数の数 |
| `switch N` | inlets = N + 1 |
| `selector~ N` | inlets = N + 1 |
| `matrix~ N M` | inlets = N、signal outlets = M、さらにstatus outletが1つ |
| `gate~ N` | outlets = N |
| `zl mode N` | inlets = 2, outlets = 2 (固定) |
| `funnel N` | inlets = N |
| `spray N` | outlets = N |

### 詳細リファレンス

`data/objects.json`はMaxオブジェクトの全仕様書ではない。identityとport metadataの
根拠・限界は`docs/object-catalog.md`、DSL形式は`docs/dsl-spec.md`を参照する。
各オブジェクトのmessage、attribute、runtime behaviorは対象Maxバージョンの
Max Object Referenceで確認する。名前に`~`を足し引きして未確認オブジェクトを
作らない。特に信号subpatch portは`inlet signal` / `outlet signal`であり、
`inlet~` / `outlet~`ではない。

## Error Messages

### Fatal Errors (コンパイル停止)

| Code | 意味 | 修正方法 |
|------|------|----------|
| E001 | 名前重複 | 同じスコープで同じ名前を使わない |
| E002 | 未定義参照 | 接続先のオブジェクトを定義する |
| E003 | 不明なオブジェクト型 | オブジェクト名を確認、DBにない場合は `--allow-unknown` |
| E004 | outlet index超過 | オブジェクトのoutlet数を確認 |
| E005 | inlet index超過 | オブジェクトのinlet数を確認 |
| E006 | inlet/outletがsubpatcher外 | `p name { ... }` の中で使う |
| E007 | 構文エラー | 行を確認 |
| E008 | 空のsubpatcher | inlet/outletを最低1つ追加 |
| E009 | 予約属性キー | `@patching_rect` など構造キーを属性にしない |

### Warnings (コンパイル継続)

| Code | 意味 |
|------|------|
| W001 | 接続の重複 |

`W002` は型定義上は存在するが、現時点の compiler は未接続オブジェクト警告を出さない。

## CLI Usage

ローカル開発時は `npm run build` 後に `node dist/cli/index.js ...` を使う。
パッケージとしてインストール済みの場合のみ `maxforge ...` が使える。

```bash
# DSL → maxpat
node dist/cli/index.js compile input.maxdsl -o output.maxpat

# maxpat → DSL（逆コンパイル）
node dist/cli/index.js decompile input.maxpat -o output.maxdsl

# バリデーションのみ
node dist/cli/index.js validate input.maxdsl

# 標準出力へ（ファイル書き出しなし）
node dist/cli/index.js compile input.maxdsl
node dist/cli/index.js decompile input.maxpat

# 不明オブジェクトを許容
node dist/cli/index.js compile input.maxdsl --allow-unknown -o output.maxpat

# Max clipboard 形式へ圧縮して標準出力
node dist/cli/index.js compile input.maxdsl --clipboard

# Max clipboard 形式を標準入力から読み、DSLへ戻す
pbpaste | node dist/cli/index.js from-clipboard -o output.maxdsl

# maxhelpとして出力
node dist/cli/index.js compile input.maxdsl -o object_name.maxhelp
```

### 逆コンパイル (Decompile)

既存の `.maxpat` ファイルをDSLテキストに変換する。

- オブジェクト名は `text` の先頭トークンまたは `maxclass` から推定され、重複時は `_2`, `_3` が付く
- 演算子オブジェクト（`*~`, `+~`等）は意味名に変換（`mul`, `add`等）
- `patching_rect` の x/y は `at(x, y)` として出力する（幅/高さはDSLでは表現しない）
- DSL→maxpat→DSLのラウンドトリップで box数/line数が一致することを確認済み

## Best Practices

### 命名規則
- オブジェクト名は**短く説明的**に: `osc`, `filt`, `dly`, `dac`
- 役割がわかる名前: `pitch_env`, `filter_cutoff`
- 略語一貫性: `vol` or `gain` — パッチ内で統一

### 接続の書き方
- メイン信号パスは**1行のチェーン**で書く: `src -> filt -> gain -> dac`
- 分岐は**別の行**に書く
- フィードバックループは最後に書く

### パッチ構造
- 50+ オブジェクトなら**サブパッチャーに分割**
- 機能単位でグループ化: `osc = p oscillators { ... }`, `fx = p effects { ... }`
- コメントはセクション区切りに使う

### maxhelp生成
- 対象オブジェクトを中央に配置
- inlet/outletの説明をcommentで記載
- 使用例をサブパッチャーで構成
- 出力時に `.maxhelp` 拡張子を指定

## Validation Checklist (出力前確認)

- [ ] 全オブジェクトが定義済み
- [ ] 全接続が有効な名前を参照
- [ ] ポート番号がオブジェクトのinlet/outlet数の範囲内
- [ ] サブパッチャーに inlet/outlet が存在
- [ ] 重複する名前がない
