# 10 — 再構築プレイブック(別エージェントの運転方法)

このパックを使って独立エージェントに再構築させるときの、フェーズ分割・完了ゲート・
運用ルール・プロンプト雛形。

## 10.1 与えるもの / 与えないもの

| 与える | 与えない |
|---|---|
| `rebuild-doc/` 一式 | 元リポジトリのソースコード |
| 公開ツールのドキュメント(git / Docker / Squid / Claude Code / Agent SDK / cmux / gh) | 元リポジトリの docs/(このパックに蒸留済み) |
| 検証用リソース(スクラッチ GitHub リポジトリ、短命 fine-grained PAT、使い捨てチケット) | 本番リポジトリ・長命トークン |

モード選択([01](01-goals-and-scope.md) §1.4): 忠実再現 A / 改良再構築 B(推奨)。
モードは最初にエージェントへ明示する。

## 10.2 フェーズ分割と完了ゲート

元システムの実構築順序をなぞる。**各フェーズの完了ゲートを通過するまで次へ進まない。**
1フェーズ = 1ブランチ + 1レビューサイクルを推奨。

モードAだけが、単一 coder を経て worker/orchestrator に分割する歴史的順序を再演する。
モードBでは R3+R6 を統合して最初から分割構成を作り、R3 の selfcheck 6項目と R6 の role
selfcheck を同じゲートで通してよい。またモードBではコンテナ優先順
**R3〜R7 → R1〜R2 → R8 → R9** も許容する。ただしこの順序でも、R3 着手前に
[04](04-native-path.md) §4.7 の `common.sh` worktree ヘルパと相対 worktree/handoff 規則を
先行実装し、後続R1/R2が同じ資産を再利用すること。

| フェーズ | 自動ゲート | 人間必須ゲート |
|---|---|---|
| R1 | shell テスト、Step 0/2、設定・pre-push 検査 | Step 1 の trust ダイアログ承認 |
| R2 | handoff/ピン/回帰負系 | cmux の実タブ・trust 検証 |
| R3 | selfcheck 6項目、コード化フロー一周 | approve 表示の対話確認 |
| R4 | broker 負系、remote SHA 照合 | 短命PATの発行/export、broker のSHA打鍵 |
| R5 | resume・完全台帳検査 | 実 publish 時のSHA打鍵 |
| R6 | role selfcheck、typed拒否、reviewer smoke | reviewer付き実 publish のSHA打鍵 |
| R7 | 属性到達、fail-open、internal 網検査 | 監視スタックを使う場合の提供・接続 |
| R8 | byte一致、config/並走/triage負系 | 必要な外部認証の提供 |
| R9 | 独立 docs-only 再実行レビュー | レビュー結果の受入判定 |

### Phase R1 — ネイティブ経路の骨格
- 成果物: `config/` スキーマ、`scripts/lib/common.sh`(render_template / template_for /
  json_get / validate_ticket_id / worktree ヘルパ)、`templates/` 4種(root / default /
  task-worker / task-orchestrator)、`setup-workspace.sh`、`create-workspace.sh`(3フェーズ)、
  `.githooks/pre-push`、`tests/run-tests.sh`。
- 仕様: [04-native-path.md](04-native-path.md) §4.0〜4.3, 4.5〜4.7, 4.9。
- ゲート: shell テスト全 green + [08](08-verification.md) Step 0〜2。
  特に: worker settings の denyWrite ピン注入(fail-closed)、excludedCommands ↔
  CLAUDE.md バイト一致、pre-push の host-first 強制。

### Phase R2 — cmux 統合と管理スキル
- 成果物: `scripts/lib/effects/cmux.sh`、cmux-wait/cmux-state、`.worker-target` ピン、
  orchestrator の4スキルスクリプト、管理スキル9種(`.claude/skills/`)、
  handoff プロトコル文書、`push-create-pr.sh`。
- 仕様: [04](04-native-path.md) §4.1, 4.4, 4.8。
- ゲート: [08](08-verification.md) Step 3〜6 + 回帰トラップ表。

### Phase R3 — コンテナ経路 Phase 0〜1(ケージ + コード化ハーネス)
- 成果物: `docker/egress/`(Squid allowlist)、compose の coder + egress-proxy、
  `harness/` の exec/gates/gitops/steps/orchestrator/types、egress-selfcheck。
- 仕様: [05](05-container-path.md) §5.0, 5.1(worker/orchestrator の前身 = 単一 coder)、
  5.3(orchestrator/steps/gates)、5.4。
- ゲート: selfcheck 6/6 + plan→implement→review⇄fix→test-gate→approve の一周
  (publish なし)。
- モードBでは単一 coder の中間形を作らず、R6 の worker/orchestrator 分割を最初から採用して
  よい。その場合は本フェーズの selfcheck 6項目と R6 の role selfcheck を併合する。

### Phase R4 — broker(Phase 2)
- 成果物: `broker/`(server/config/handler/git/approve/types)、broker-policy.json、
  publish.ts。
- 仕様: [05](05-container-path.md) §5.2、[07](07-security-invariants.md) INV-4〜6(F1〜F6)。
- ゲート: スクラッチリポジトリへの実 publish(SHA 打鍵 → 承認 sha ちょうどが着地)+
  F2 の負系(coder ツリー内ポリシー拒否、dirty/branch-mismatch/detached の各 fail-closed)。

### Phase R5 — マルチリポジトリ driver(Phase 3)
- 成果物: `harness/src/multi/`(driver/state/worktree/config)。
- ゲート: 2リポジトリチケットの E2E + resume(published スキップ)+ 正直な部分成功
  レポート。

### Phase R6 — M1〜M4(分割 + rails + reviewer)
- 成果物: workerd(protocol/handlers/server/client)、compose の worker/orchestrator 分割、
  spine 一式、`reviewer/`、egress-selfcheck-role、テスト5スイート。
- 仕様: [05](05-container-path.md) §5.1〜5.3, 5.7、[07](07-security-invariants.md) INV-9〜11。
- ゲート: role selfcheck 両 PASS、`invariants_not_met` の typed 拒否、reviewer の
  悪意 diff `concerns` 判定スモーク、reviewer 有効の実 publish。
- モードBで R3 と統合済みなら、ここでは統合ゲートの未通過項目だけを満たせばよい。

### Phase R7 — telemetry(item 10)
- 成果物: telemetry.ts + broker/reviewer 側ミラー、`mrw-telemetry` 網、compose 配線。
- 仕様: [05](05-container-path.md) §5.3(telemetry)、[07](07-security-invariants.md) INV-12。
- ゲート: operator が監視スタックを提供する場合は Loki 着地、無い場合は debug exporter
  付き最小 collector 1コンテナへの OTEL 属性到達 + collector 停止で fail-open 完走 + **網の internal 検証を起動
  スクリプトに実装**(モード B では必須 — [09](09-known-issues.md) C)。

### Phase R8 — mrw CLI(Phase 1〜2 相当)
- 成果物: state_root 外部化、`cli/mrw.mjs`、`.mrw/` per-workspace config、triage leaf、
  native パリティ。
- 仕様: [06-mrw-cli.md](06-mrw-cli.md)。
- ゲート: 後方互換 byte-identical、config round-trip byte-clean、tasks/ 配下 `.mrw/`
  exploit のブロック、外部 state_root のライブ検証、triage の graceful degradation。
  モード B では追加で: config 解決の canonicalize+validate 単一実装、pre-push への
  config パス焼き込み、triage の reviewer 型 posture([09](09-known-issues.md) A/B)。

### Phase R9 — ドキュメント
- 成果物: README(en/ja)、architecture、handoff-protocol、settings-reference×3、
  verification-guide、devcontainer-status 相当。
- ゲート: 実装コンテキストを持たない独立レビューエージェントへ docs だけを渡し、[08]
  (08-verification.md) の検証シーケンスを docs の記述どおりに再実行させる。全コマンド・パス・
  フラグが成果物と逐語一致し、推測や元コード参照なしで各合否を判定できたときだけ完了。

## 10.3 運用ルール(元プロジェクトで実証済みのワークフロー)

1. **実装はサブエージェントに委任し、検証・チェックは運転者(あなた/メインエージェント)
   が行う。** 実装者の自己申告を完了根拠にしない。
2. **成果物は別コンテキストの独立レビューにかけ、指摘を反映してからコミット。**
   セキュリティ経路に触れる変更(pre-push、broker、サンドボックス設定生成、config 解決)
   は独立レビュー + ライブ検証を必須とする。実績: この運用が per-workspace config の
   push ガード迂回脆弱性をコミット前に捕捉した。
3. **1ブランチ運用**: 全フェーズを1つのフィーチャーブランチに commit & push し、
   全体完了後にまとめてマージ(または フェーズごと PR — どちらかを最初に決めて一貫させる)。
4. **ライブ検証の道具立て**: スクラッチ GitHub リポジトリ(private)、短命(7日)
   fine-grained PAT、使い捨てチケットID(TEST-*, DEMO-*)。本番リソース禁止。
5. **fail の扱い**: テスト失敗・ゲート不通過は隠さずそのまま報告させる。
   「一通り動いた」ではなく [08](08-verification.md) のチェックリストで判定。
6. **検証リソースの引き渡し**: スクラッチリポジトリ名、短命PATの受け渡し方法、
   使い捨てチケットIDの採番規則はフェーズ着手前に運転者が明示する。成果物へ保存しない。
7. **ゲート報告**: ブランチ内 `docs/rebuild-log/R<phase>.md` に、実行日時・mode・commit SHA・
   各ゲートの PASS/FAIL/SKIP・生出力・人間実施者を記録する。

## 10.4 初回プロンプト雛形

```
あなたは muti-repo-workspace 相当のシステムをゼロから再構築するエージェントです。

入力: rebuild-doc/ ディレクトリの 01〜10 と README。これが唯一の仕様です。
元実装のコードは参照できません(存在しない前提で書いてください)。

モード: B(改良再構築)。09-known-issues.md の A/B/C 3系統は設計段階から回避し、
それ以外の実装は仕様に忠実に従ってください。

絶対条件:
- 07-security-invariants.md の INV-1〜14 は 1 つも緩めない。
  判断に迷ったら fail-closed を選ぶ。
- 各フェーズ(10-rebuild-playbook.md §10.2)の完了ゲートを通過するまで
  次のフェーズに進まない。ゲート結果は生の出力を添え、
  docs/rebuild-log/R<phase>.md に所定書式で記録する。
- 生成ファイルへの絶対パス埋め込み禁止、テンプレート + ランタイム置換のみ。
- 人間必須ゲートに到達したら必ず停止し、運転者を呼ぶ。trust/cmux操作、短命PATの
  発行・export、SHA打鍵をエージェントが代行してはならない。
- 仕様間の矛盾を発見したら自己判断で一方を選ばず停止し、相反する箇所を示して運転者に
  裁定を求める。
- スクラッチリポジトリ名、PATの受け渡し方法、使い捨てチケットIDの採番規則は運転者が
  フェーズ開始前に渡す。未提供なら外部ライブ検証の前で停止する。

まず Phase R1 から始めてください。着手前に、R1 の成果物一覧と
検証計画(何をどう確かめるか)を短く提示してから実装に入ってください。
```

## 10.5 運転者(人間 or 上位エージェント)のチェックポイント

- 各フェーズ開始時: 成果物一覧と検証計画がゲート定義と一致しているか。
- 人間必須ゲートの実施はエージェントの到達報告を待たず、運転者が事前にスケジュールする。
- 各フェーズ完了時: [08](08-verification.md) の該当項目を**自分で**(または独立レビュー
  エージェントで)再実行。特にセキュリティ負系(〜できないことの確認)は実装者以外が回す。
- R4 / R8 完了時: [07](07-security-invariants.md) を頭から通読し、1項ずつ現物に当てる。
- 全体完了時: [08](08-verification.md) §8.3 チェックリスト + 元システムとの差分
  (意図的な改良点)の一覧化。
