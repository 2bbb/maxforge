# Max/MCP 手動テストチェックリスト

このチェックリストは、CIが通過した後にだけ実行する。ソースレベルのテストでは証明できない挙動を対象とする。プロセスの再起動、ファイル作成、patcherの変更を意図的に行うため、重要なpatchをテスト対象にしてはいけない。

## テスト記録

テスト開始前に、次のブロックをreleaseまたはissueの記録へコピーする。

```text
実施日:
実施者:
commit/tag:
npm maxforge version:
maxforge.sync externalVersion:
Max version:
MCP host/version:
Node/npm versions:
OS/architecture:
Max package/external path:
MAXFORGE_CONFIG path/project.id:
結果: PASS / FAIL / BLOCKED
失敗内容と証跡へのリンク:
```

各テストでは、必要に応じて対象の`patcherId`、scope、broker PID、structure token、revisionを記録する。スクリーンショットはUIやOS security動作の証跡にはなるが、protocol failureの証跡にはならない。protocol failureにはstructured MCP outputとMax Consoleのテキストを使う。

## Release gate

通常のrelease candidateでは、macOSでH01〜H06とH09を実行する。LAN関連を変更した場合はH07、project catalog/config関連を変更した場合はH08、built-in catalogを変更した場合はH10、native package alignment skillを変更した場合はH11、native external・package構成・CI toolchainを変更した場合はH09のWindows項目も実行する。

### H01 — Native externalの検出と登録

**前提:** Max、release candidateのMax package、それとversionが一致するnpm package。

1. Maxのsearch pathから、開発中のものを含む重複した`maxforge.sync`を削除するか一時的に名前を変える。重複を放置した場合、意図したbinaryをテストした証明にならない。
2. Maxを起動し、installしたpackageから`maxforge.sync.maxhelp`を開く。
3. objectがmissingになっていないこと、Max Consoleに赤色のload、class、attribute、WebSocket、registration errorがないことを確認する。
4. MCP entryを起動または再接続し、`maxforge_status`、続いて`maxforge_list_patches`を呼ぶ。
5. help patchが登録され、`externalVersion`がnpm runtimeのexpected versionと一致し、`versionCompatible`が`true`であることを確認する。

**合格条件:** 意図したbinaryがMax errorなしでload・registerされる。

### H02 — 人間による編集後のAgent差分sync

**前提:** 3個以上の接続済みobjectを含む、破棄可能なregistered patch。

1. 対象をsummary detailとfull detailでinspectし、structure tokenを記録する。
2. Max UI上で、managed objectを1個移動し、`button`を1個追加し、既存patch cordを1本つなぎ替える。何を変更したかはAgentへ伝えない。
3. Agentにlive changesのinspect/reviewと変更内容の説明を依頼する。画面ではなくMCP stateから説明させる。
4. `maxforge_get_live_edit_history`と`maxforge_review_live_changes`のdefault summaryが、move、addition、rewireをevidenceとして説明しつつ、full snapshot/raw changes/完全DSLを返していないことを確認する。正確なbefore/afterが必要な箇所だけ`detail: "full"`で再取得する。
5. 現在の正確なstructure tokenを使い、受け入れるmanaged editsをadoptする。完全DSLではなく`sourceRef`が返ることを確認する。
6. `maxforge_get_working_source`の`detail: "matches"`で必要なsemantic name周辺だけを取得し、`baseSourceRef`とhalf-open line editsでobjectとconnectionをもう1組prepareする。compact responseがoperation count、全破壊操作、replacement、warningを含み、bulk create/connect/rollback planを含まないことを確認する。
7. `maxforge_apply_prepared_change`へreceiptだけを渡す。acknowledgement後に同じreceiptの再利用が拒否されることを確認する。
8. 再度inspectする。3つの人間編集がすべて残り、reviewしたAgent差分だけが追加されていることを確認する。

**即時失敗条件:** Agentがreviewしていない編集を上書きする、windowの見た目に依存する、stale tokenを使う、またはedit-historyの推論を人間の意図として断定する。

### H03 — Top-level patchの作成、保存、close、reopen

**前提:** controller capabilityを持つregistered patchが1個だけ存在し、書き込み可能なtemporary directoryがあること。

1. 一意な`patcherId`、scope、titleを指定し、`maxforge_create_patch`で新規patchを作成する。
2. そのpatchが、`maxforge.sync`を1個だけ含む独立したtargetとしてregisterされることを確認する。
3. `button`、`counter`、`print`を含む小さなdesired DSLをprepareし、返されたreceiptだけをapplyしてconnectionをinspectionで検証する。
4. `maxforge_save_patch`でabsolute temporary `.maxpat` pathへ保存する。Maxがclean patchを報告し、ファイルが存在することを確認する。
5. `maxforge_close_patch`でcloseし、target listから消えることを確認する。
6. 保存したファイルをMaxから通常の方法で開き直す。すでに`maxforge.sync`を含むため、`maxforge_open_patch`へ渡してはいけない。自動的にregisterされ、期待するgraphとsaved pathを保持していることを確認する。
7. 別途、sync objectを含まないplain `.maxpat`を作る。それを`maxforge_open_patch`で開き、Maxforgeがsync objectを正確に1個だけinjectし、patchをdirtyにし、独立したtargetとしてregisterすることを確認する。

**合格条件:** duplicate sync objectや曖昧なwindow選択を起こさず、target identityとgraphがfile lifecycle全体で維持される。

### H04 — Frontend、broker、Max、MCP hostの再起動と永続化

**前提:** H03で保存したpatchと、固定された`project.id`。

1. broker PID、working `sourceRef`、graph revision、edit-history persistence status、saved pathを記録する。
2. MCP entryだけを再起動する。同じbroker PIDへattachし、targetを引き続きinspectできることを確認する。
3. すべてのMCP entryとMax clientを閉じ、意図的に短く設定した`MAXFORGE_BROKER_IDLE_MS`を超えるまで待つ。`maxforge broker status`が接続できなくなることを確認する。
4. patchとMCP entryを開き直す。新しいbrokerがprojectを所有し、writer-lock errorなしで保存済みsource、baseline、historyを復元することを確認する。再起動前の未使用receiptはprocess-localなので失効し、復元した`sourceRef`から新しくprepareできることを確認する。
5. brokerを停止せずMaxを終了し、Maxと保存済みpatchを開き直す。native retry registrationによってinspectionが復旧することを確認する。
6. outer MCP host（例: Codex）を一度再起動する。設定済みMaxforge entryがinitializeし、同じtargetをlistできることを確認する。

**合格条件:** 各再起動がdocumented ownership behaviorに従い、stale target、duplicate owner、永続stateのsilent lossが発生しない。

### H05 — Package version mismatchとbroker upgrade

**前提:** 2種類のMaxforge npm versionを用意し、破棄できないpending operationが存在しないこと。

1. 古いpackageでbrokerを起動し、同じprojectに対して新しいpackageのMCP entryを起動する。
2. MCP initializationがdiagnostic modeで成功し、`maxforge_status`だけを公開し、両方のversionと古いbroker PIDを含む`VERSION_MISMATCH`を報告することを確認する。
3. 使用するpackage versionでbrokerをstop/restartする。`--force`は、clientを切断してよいことを確認した場合だけ使う。
4. 開いたままのdiagnostic entryからstatusを再度呼ぶ。replacementのPID/versionを含む`RECONNECT_REQUIRED`を報告し、mutation toolは依然として公開しないことを確認する。
5. outer hostを再起動せず、そのMCP entryだけを再接続する。full tool setが現れ、通常のpatch listingが動作することを確認する。

**合格条件:** version mismatch中はmutation toolを公開せず、statusはcached resultではなくlive stateを返し、host全体ではなくMCP entryのreconnectだけでupgradeが完了する。

### H06 — Max error channel

1. 破棄可能なpatchで、tokenを指定せずに`maxforge.sync @host 192.0.2.1`をinstantiateする。tokenなしのnon-loopback hostはnetwork connection前に意図的にrejectされる。
2. messageが通常の`post`ではなく、error severity（赤色）でMax Consoleへ表示されることを確認する。
3. 有効な設定へ戻し、errorが明示的に要求しない限りMaxを再起動せず、その後のregistrationが成功することを確認する。

**合格条件:** 対処可能なnative failureがMaxのerror channelを使い、recoveryを観測できる。

### H07 — 認証付きLAN操作

**前提:** trusted LAN上の2台のmachineと、選択したportへのfirewall access。

1. broker machineで、人間が決めた`MAXFORGE_WS_TOKEN`を設定する。effective bindがnon-loopback、または明示指定したLAN addressであることを確認する。
2. Max machineの`maxforge.sync`に、broker machineのLAN address、port、一致するtokenを設定する。
3. registration、inspection、prepare済みreceipt applyを1回、acknowledgementまで確認する。
4. Max側tokenを誤った値へ変更する。設定したtokenをlogへ漏らさず、registrationとmutationがrejectされることを確認する。
5. non-loopback bindを要求したままtokenを削除する。startupがrejectされることを確認する。このplaintext WebSocketをInternetへ直接公開してはいけない。

**合格条件:** 一致するtokenだけがLAN越しにpatchを制御でき、証跡にsecretが含まれない。

### H08 — Project externalとabstraction catalog

1. 正確な`ports.mode`/rules、artifact/search pathsを含め、custom externalを1個、abstractionを1個project catalogへ設定する。
2. absolute `MAXFORGE_CONFIG` pathを指定してMCPを起動し、`maxforge_catalog`で両方のentryを確認する。
3. desired DSLを使ってMax上に両方をinstantiateし、実際のinlet/outlet topologyを確認する。
4. catalog metadataを変更し、`maxforge_reload_catalog`を呼ぶ。Max registrationを切断せずdigestが変わることを確認する。
5. declarationを残したまま実際のMax artifactを取り除く。compiler catalogには表示され続ける一方、Maxはruntime load failureを報告することを確認する。

**合格条件:** declaration metadataはcompileを制御し、runtime availabilityは別のMax search-path問題として正しく扱われる。

### H09 — 公開済みnpm packageとdownload可能なMax package

1. clean temporary directoryで、`npx -y --package=maxforge@<version> maxforge --help`を使って公開済みの正確なversionを実行する。続いてMCP test clientから`npx -y --package=maxforge@<version> maxforge-mcp`をinitializeする。
2. `node dist/...`を直接実行した場合だけでなく、npm bin link経由でMCP initialize responseが返ることを確認する。
3. 対応するversioned GitHub Releaseから`maxforge-v<version>.zip`をdownloadし、同名の`.sha256`と展開前に一致することを確認する。moving `latest` release/tagやunversioned assetを使ってはいけない。
4. Maxが対応するpackage/search-pathの方法でpackageをinstallする。
5. macOSでは、必要ならdocumented security actionを実施した後、universal externalがloadされることを確認する。Windowsではx64 `.mxe64`がMaxでloadされることを確認する。
6. 同梱help patchを開き、H01のversion-compatible registration checkを繰り返す。

**合格条件:** npm version、native external version、Git tag/release、download artifactが同じsourceを示し、clean installation pathから動作する。

### H10 — Built-in object catalogの一次資料監査

**前提:** 対象バージョンのMaxが`/Applications/Max.app`、または既知の別pathへinstallされていること。

1. Maxの正確なversionと、監査対象の`C74` resources pathを記録する。
2. repository rootで`python3 scripts/audit-object-catalog.py --max-root <C74-resources-path>`を実行する。
3. `errors=0`で終了することを確認する。warningは黙認せず、対象objectのreference、help patch、saved patcherを確認して理由を記録する。
4. 今回追加・変更した全objectをMaxのobject boxでinstantiateし、missing objectにならないことを確認する。
5. port metadataを変更したobjectは、空の引数と代表的な引数の両方で実際のinlet/outlet数と型を確認する。引数依存objectは最低値、通常値、上限付近を含める。
6. `objectfile` mappingしか根拠がない名称をcatalogへ追加していないことを確認する。`s~` / `r~`をsignal objectとして扱わず、`send~` / `receive~`を使う。

**合格条件:** catalog identityはreference、object index、database、またはsaved patcherの一次資料で裏付けられ、変更したport shapeが実際のMaxと一致する。

### H11 — Skillによるnative package version alignment

**前提:** 現行npm runtimeとversionが異なる、破棄可能な旧`maxforge` Max package。未保存patchをすべて保存または閉じられること。

1. 旧externalをloadした状態で`maxforge_status`と`maxforge_list_patches`を呼び、`expectedExternalVersion`、旧`externalVersion`、`versionCompatible: false`を記録する。
2. `maxforge-mcp` skillのalignment手順を実行させる。Agentがpatch filepathだけでbinary pathを断定せず、標準package rootとproject/configured search pathを確認することを確認する。
3. activeなcandidateを2個用意した場合、Agentが両方を無断上書きせず、残すpathを一度だけ確認することを確認する。選ばれなかったcopyはMax search path外へ移す。
4. Maxを閉じ、skill同梱scriptへexact versionと選択したabsolute package rootを渡す。`maxforge-v<version>.zip`と`.sha256`だけを取得し、checksum、package structure、`package-info.json` version、macOS署名を検証することを確認する。
5. 旧package全体のbackupが`~/.maxforge/backups/native`へ作られ、active pathに旧binary、rename済みcopy、backup packageが残らないことを確認する。
6. Maxとcontroller patchを開き直し、MCP frontendも同じexact npm versionへ固定して再接続する。status/listでfrontend、broker、expected external、loaded externalが一致し、`versionCompatible: true`になることを確認する。
7. 存在しないversionを`--verify-only`で指定し、moving latestや別versionへfallbackせず失敗することを確認する。

**合格条件:** Skillがversion不一致を検出だけで終わらせず、曖昧な複数copyを破壊せずにexact releaseを検証・backup・完全置換し、再登録後の一致まで確認する。

## Cleanup

- 意図しない変更を保存せず、破棄可能なpatchを閉じる。
- H03で作成したtemporary `.maxpat`を削除する。
- 通常使用するMCP package version、broker idle timeout、config、bind address、token、firewall rulesへ戻す。
- 同じ`project.id`を使う別のMCP/Max clientがないことを確認してからtest brokerを停止する。
- 一時的に名前を変えたexternalを元へ戻す。ただしMax search pathにactiveなduplicate copyを残してはいけない。
