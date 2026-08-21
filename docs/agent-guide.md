# maxforge / maxdsl — AI Agent Guide

Max/MSPパッチを記述する非公式DSL。生JSONの代わりにコンパクトなテキストで記述し、`maxforge` CLIで `.maxpat` に変換する。

## Trigger

ユーザーがMaxパッチの生成・作成を要求したとき。`.maxdsl` ファイルを書いてコンパイルする。

一般的なMax/MSPの質問ではなく、maxforgeを使う作業のセッション初回にだけ、
利用中のskillに同梱されたversion preflightを実行する。

```bash
node <skill-directory>/scripts/refresh-skills.mjs --json
node <skill-directory>/scripts/check-version.mjs --json
```

最初にSkills lockのsource/hashを確認し、差分があればskillを更新する。
`reloadRequired`なら更新後の`SKILL.md`を読み直してからversion確認へ進む。
Skills CLIがupstream確認に失敗した場合は、exit codeが0でも最新版とは扱わない。
成功したskill確認とGitHub Release/npm情報は24時間キャッシュするが、MCP設定と
Max packageは毎回読み直す。`update-available`は更新通知であり、無断インストールの許可ではない。
`unknown`/`stale`ならローカル作業を継続できるが、最新版を断定しない。
`LOCAL_VERSION_MISMATCH`または`MCP_MOVING_VERSION`がある状態ではlive mutationを
行わない。`npx skills update`はskillの指示を更新するだけで、MCP設定やMax packageを
自動更新しない。

ユーザーが更新を依頼した場合は、skill更新後に対象releaseを確定し、MCP pin、
常駐broker、Max package全体の順に揃える。skillまたはMCP設定が変わったらCodexの
再起動（またはMCP再接続と新しいAgent session）を促す。Maxは更新前に起動していた
場合だけ再起動を促し、起動していなかった場合は不要と明記する。

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

省略時はMax JSONへ明示的な`title`を保存せず、`description`は空、patcher
rectangleは`640x480`。表示タイトルをファイル名から推測してDSLへ捏造しない。
title/descriptionはJSON文字列escapeを使い、quote内の`|`は区切りではない。

### Object Definition

```
name = type [args...] [@attr val ...] [at(x, y[, width, height])]
```

- `name` — 英字/アンダースコア始まりの識別子。スコープ内で一意。
- `=` 以降がMaxのtextフィールドになる。
- `numinlets`/`numoutlets`/`outlettype` は、監査済み固定値・引数ルール・dynamic markerのいずれかで解決する。DSLに直接書かない。
- `@attr val` — **省略可**の属性指定。box JSONに直接出力される。
- newobjの`text`にMax attributeを残す場合は`\@attr`と書く。未escapeの`@attr`はbox JSON propertyとして解釈される。
- `at(x, y)` — **省略可**の座標指定。指定するとauto-layoutを上書き。省略時は自動配置。
- `at(x, y, width, height)` — resizeを含む完全なbox rectangleを保持する。

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

# 連続ポートをinclusive rangeでzip接続
src[0..3] -> dst[2..5]

# ポート番号は 0-indexed（左端 = 0）
```

**注意事項:**
- 接続先のオブジェクトは**先に定義**されている必要がある。
- range接続は2オブジェクト間に限定し、左右を同じ本数にする。上の例はoutlet 0〜3をinlet 2〜5へ順番に4本接続する。
- rangeとscalarの混在やrangeを含むchainは意図を推測せずエラーにする。decompile結果は個別接続へ展開され、range記法には戻らない。
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
- DSL名は役割を表す意味的な名前にする。例えばscope `synth`の
  `filter_cutoff`は`maxforge_synth_obj_filter_cutoff`になる。DSL名の変更は
  表示名の変更ではなくidentityの置換である。
- ユーザーが名前を指定していない場合、既存DSL、object text、コメント、
  周辺の接続、同一パッチ内の命名規則を読んでから名前を決める。
  `obj1`、`thing`、`temp`のような使い捨て名を付けない。
- 人間が追加したunmanaged objectを自動的にmanaged扱いにしない。文脈から
  名前を提案できても、管理対象へ取り込む意図が確定してからcomplete DSLへ含める。
- `baseRevision`が現在のrevisionと一致しないplanは適用しない。
- managed scope外のオブジェクトを削除・変更しない。
- DSLはdesired stateとして扱い、`delete`などの命令型構文を追加しない。
- Max内では`maxforge.sync @scope voices`へ`apply <compact-json>`を送るか、
  named `dict`を`applydict <name>`で適用する。
- `maxforge.sync`はJavaScriptや`thispatcher`を経由せずMax SDKでpatcherを変更する。
- protocol v1はruntime failure時にreverse operationsを試行するが、transactionalなrollbackは保証しない。
- 詳細は`docs/patch-sync.md`を参照。

### MCP経由のlive managed patch

MCPクライアントからMaxを変更する場合は、次の順序を崩さない。

1. `maxforge_prepare_change`、`maxforge_apply_prepared_change`、
   `maxforge_get_working_source`が利用可能か確認する。skillでこの契約が既知なら、
   毎回の`maxforge_help`呼び出しは不要。tool不足、契約不明、失敗復旧時だけhelpを使う。
2. custom external/abstractionを使う場合は`maxforge_catalog`で実際の定義を確認する。
   設定変更後は`maxforge_reload_catalog`を呼び、新digestを確認する。失敗時は旧catalogが
   そのまま有効であり、部分更新とは扱わない。
3. `maxforge_list_patches`から正確な`patcherId`とscopeを選び、
   `versionCompatible: true`を必須とする。titleやfilepathから対象を推測しない。
4. 別windowが必要なら`maxforge_create_patch`、既存`.maxpat`ならMax host上の絶対pathで
   `maxforge_open_patch`を使う。
5. `maxforge_inspect_patch`のsummaryでrevision、structure token、box/cord数、差分を読む。
   全topologyが必要な場合だけfullを要求する。第三revisionを伴うpending applyは通常操作を
   止め、`maxforge_inspect_pending_apply`とtoken-bound recoveryを使う。state削除やDSL推測で
   回避しない。
6. live changeがあれば`maxforge_review_live_changes`を呼ぶ。default summaryはagent負荷を
   下げるためsnapshot、raw changes、重複signal、完全DSLを返さない。正確なbefore/afterが
   必要な場合だけ`detail: "full"`を要求する。cluster/riskは意図の証明ではない。
7. 現在のmanaged graphを基準にするならreviewの正確なtokenで
   `maxforge_adopt_live_changes`を呼び、返された`sourceRef`を保持する。次のdesired stateが
   既にあるなら、後述のprepareへ`manualChanges: "merge"`を指定する。
8. source転送を最小化する。新規作成・広範な書換えでは完全な`desiredDsl`を一度だけ送る。
   局所変更では`maxforge_get_working_source`の`detail: "matches"`で意味のあるDSL名や文字列を
   検索し、必要なsnippetだけ読む。`detail: "full"`は広範な書換えまたは復旧に限定する。
9. `maxforge_prepare_change`へ、完全な`desiredDsl`、または最新`baseSourceRef`と`edits`の
   どちらか一方を渡す。edit rangeは1-based half-open `[startLine, endLine)`で、同値ならinsert。
   全rangeは元source基準で重複不可。これは転送差分であり、DSLのfull desired-state semanticsは
   変わらない。`workingDslRequiredAsCurrent: true`ならinline時は`currentSourceRef`、局所編集時は
   `baseSourceRef`としてそのrefを使う。
10. `canApply: true`を必須とし、operation count、全delete/disconnect、replacement、warning、
    conflictを確認する。bulk create/connect/rollback planはbroker内に保持され、agentへ返らない。
11. 変更前に対象、operation数、破壊操作、停止条件を明示し、
    `maxforge_apply_prepared_change`へ`receiptId`だけを渡す。receiptはcatalog/revision/structureに
    結び付いた一回限りのprocess-local値で、native mutation前に消費される。timeout、拒否、warning
    後に再送せず、status/inspect後に新しいreceiptをprepareする。
12. acknowledgement revisionとtargetRevisionの一致を成功条件とする。verificationがあれば同じ
    revisionとbox/cord数を確認する。返された`sourceRef`とsourceCharactersだけを保持し、次の局所
    編集時に必要な範囲だけ取得する。applyは自動保存しないため、永続化する場合だけ
    `maxforge_save_patch`を呼ぶ。

stdio frontendだけの再起動では共有broker stateは失われない。broker再起動後もpersist済みの
working sourceは復元されるが、未使用prepared receiptは復元されない。stateが本当に無い場合だけ
以前の完全なDSLを`currentDsl`として一度渡す。revision hashからgraphを推測してはいけない。

managed manual changeをinspectしただけではbaselineは更新されない。採用はexact token付きadopt、
次状態との統合は`manualChanges: "merge"`付きprepareで明示する。同一field競合、change-vs-delete、
ownership、unmanaged cord破壊はfail-closedで解消する。prepare後に人間がbox/cordを変えた場合、
native externalがstructure tokenを変更直前に再照合して拒否する。receiptは既に消費済みなので、
同じapplyを即時再送してはいけない。

Max側は`examples/mcp_bridge/`の通り、接続設定を持つnative
`maxforge.sync`を1個だけ置く。接続、再接続、登録、request/eventの
送受信はexternal内部で完結し、bootstrap用のpatch cordは不要。
複数パッチをタイトルで推測せず、必ず`patcherId`で指定する。Max内で
JavaScriptを追加したり、agentに生の`thispatcher`コマンドを生成させたり
しない。

live操作を継続的にagentへ任せる場合は、汎用DSL skillとは別に安全規約を持つ
専用skillを導入する。

```bash
npx skills add bbb-max-externals/maxforge --skill maxforge-mcp
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

### Project external / abstraction catalog

builtin databaseにないthird-party externalや、別ファイルの`.maxpat`
abstractionを`--allow-unknown`で誤魔化さない。project rootの
`maxforge.config.json`にport metadataを宣言する。

```json
{
  "$schema": "https://2bit.jp/maxforge/schema/config-v1.json",
  "schemaVersion": 1,
  "project": { "id": "studio_patchset", "name": "Studio Patchset" },
  "objects": [
    {
      "name": "vendor.filter~",
      "kind": "external",
      "ports": {
        "mode": "fixed",
        "inlets": 2,
        "outlets": ["signal", ""]
      }
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

CLIの`compile`、`validate`、`plan`、`bundle`は入力DSLから上方向へ設定を探索する。
明示指定は`--config`、事前検査は`maxforge doctor --input input.maxdsl`を使う。
MCPはcwd探索を行わないため、server起動設定で`MAXFORGE_CONFIG`に絶対pathを
渡す。catalog変更後は`maxforge_reload_catalog`を呼び、`maxforge_catalog`で
新しいdigestを確認する。server再起動は不要で、reload失敗時は旧catalogが残る。
MCPのstate/edit historyを再起動後もproject単位で保持する場合は、一意で安定した
`project.id`をroot configへ設定する。保存pathはlocatorでありpatch identityではない。
pathの衝突warningは自動解決しない。`maxforge_get_patch_history_identity`でcanonical
identity、aliases、過去のdecisionを確認し、人間が同一性を確認した場合だけsourceを
閉じて`maxforge_resolve_patch_history_identity`を使う。`rekey`は未使用IDへの変更、
`merge`は既知IDへの統合、`forget`はAgent-facing lookupからの論理除外である。
いずれもlive `maxforge.sync`のroutingや元のNDJSONを書き換えず、`forget`も物理削除ではない。
人間が履歴そのものの削除を明示した場合だけ、全Max clientを閉じ、
`maxforge_status.bridge.connectedClients == 0`を確認してから
`maxforge_erase_project_history`へ正確なproject IDと
`ERASE PROJECT HISTORY <project.id>`を渡す。この操作はhistory chunkとidentity ledger、
bridge上のretained observationを削除するが、Max patch、DSL/config、desired-state cacheは
削除せず、SSD等のsecure overwriteも保証しない。
永続historyはhistory directoryごとにsingle writerである。sessionごとの
`maxforge-mcp`はproject brokerへ接続し、brokerだけが`writer-v1.lock`を所有する。
broker異常終了後は、記録されたprocessが死んでいる有効なleaseだけをreplacementが
atomicに回収する。live processまたは検証不能なleaseは置換しない。lockを消して
並行writerを起動してはいけない。history persistenceを無効化した場合、このguardも無い。

agentは`maxforge_catalog`の結果とdigestを確認してからcustom objectを使う。
ただしcatalog entryはcompiler metadataでしかない。Max側machineへのexternal
install、abstraction search path、binary architecture、内部dependencyの存在を
証明しない。画面や名前からavailabilityを推測してはいけない。

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
| E010 | ポートrangeが不正 | 昇順・同じ本数・2項間接続・100,000本以下にする |

### Warnings (コンパイル継続)

| Code | 意味 |
|------|------|
| W001 | 接続の重複 |

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

# project catalogとabstraction metadataの事前検査
node dist/cli/index.js doctor --input input.maxdsl

# effective object catalogの検索（query指定時はbuilt-inも対象）
node dist/cli/index.js catalog cycle~ --json

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

- オブジェクト名は、意味を持つbox ID (`obj-name`)、通常の`varname`、`text`の
  先頭トークン、`maxclass`の順で復元・推定され、重複時は`_2`, `_3`が付く。
  `obj-1`のようなMax標準の連番IDは名前として使わない。
- `maxforge_<scope>_obj_...`はmanaged ownership用なので、通常のdecompileが
  genericな`varname` fallbackとして採用することはない。managed graphは
  scope-aware serializerでDSL名を復元する。
- 演算子オブジェクト（`*~`, `+~`等）は意味名に変換（`mul`, `add`等）
- 通常のdecompileは`patching_rect`のx/yを`at(x, y)`として出力する。
- human edit adoptionが返すworking DSLはresizeを失わないよう`at(x, y, width, height)`を使う。
- 人間による編集の順序が判断に必要なら`maxforge_get_live_edit_history`を使う。
  `supported`、`droppedEvents`、`comparisonBasis`を確認し、75ms内の複数編集は
  1件に畳まれること、履歴は再接続で消えること、結果は意図やundo操作を証明
  しないことを前提にする。現在状態の正本は常に`maxforge_inspect_patch`で読む。
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
- [ ] custom object使用時は`doctor`が成功し、MCPなら`maxforge_catalog`と一致
- [ ] catalog entryをMax runtime availabilityの証明として扱っていない
