# 05 — 独立再構築に必要だが未仕様の領域(Medium: 文書追補)

「このリポジトリのコードを参照できないエージェントがゼロから再構築できる」
(01 §1.1)を満たすために、追補が必要な箇所。多くは「LLM が創作すればよい自由度」
だが、**自由度なのか欠落なのかがパック内で区別されていない**のが問題。
検証ゲートが暗黙にテンプレ内容へ依存している箇所は特に危うい。

## 1. テンプレート本文(prose)が全く仕様化されていない — 最大の自由度

- 対象: `templates/task-worker/CLAUDE.md`、`templates/task-orchestrator/CLAUDE.md`、
  各 `initial-prompt.md`、`templates/default/CLAUDE.md`、purpose 別テンプレ。
- 04 §4.2 は「どのテンプレがどこへ行くか」を定めるが、**中身の要件**が無い。
  一方で検証(08 Step 3)は「worker が `docs/task.md` を読み始める」
  「最初の handoff report 後に idle(exit しない)」というテンプレ本文由来の挙動を
  合格条件にしており、INV-14 は「excludedCommands ↔ 生成 CLAUDE.md のパスは
  バイト一致」を要求する(= orchestrator CLAUDE.md に5スクリプトのリテラルパスが
  載ることが暗黙前提)。
- **改善候補**: 各テンプレについて「必ず含むべき指示の箇条書き」を 04 に追加する。
  例(worker CLAUDE.md): (1) 起動時に docs/task.md を読む (2) handoff 書式と
  ファイル名規則(§4.4 参照)(3) 特権行為は requests: で依頼し idle する/exit しない
  (4) push・PR・パッケージ導入を自分で試みない。文面そのものは自由度と明記する。

## 2. 監視スタック(otel-collector / Loki)が前提なのに未仕様

- 05 §5.1 は「**隣接する監視スタック**の otel-collector:4317」に依存し、
  08 §8.2-8 と R7 ゲートは「**Loki に着地**」を合格条件にする。
  しかし 01 §1.5 の前提環境に監視スタックは無く、その構成(collector が
  mrw-telemetry 網に参加する方法、Loki への export 設定)はパック外。
- 再構築エージェントは R7 ゲートを**通過できない**(検証手段が存在しない)。
- **改善候補(いずれか)**: (a) 最小の検証用 collector+Loki compose 仕様を 05 に
  追補する、(b) R7 ゲートを「operator が監視スタックを提供する。無い場合は
  collector コンテナ1つ(debug exporter)で属性到達のみ検証」に緩めて明記する。
  (b) が軽くて推奨。

## 3. Phase R3 の中間トポロジ(単一 coder)が未仕様

- 10 §10.2 R3 は「compose の **coder** + egress-proxy」(worker/orchestrator の前身)を
  成果物に指定するが、05 は**最終形(5サービス)しか記述していない**。
  単一 coder のマウント・ソケット・env 構成は推測で作るしかなく、R6 で捨てる
  スキャフォールドでもある。
- **改善候補(推奨)**: モードB では R3/R6 を統合し「最初から worker/orchestrator
  分割で作ってよい(ゲートは R3 のセルフチェック6項目 + R6 の role selfcheck を併合)」
  と明記する。歴史的順序の再演はモードA 限定にする。中間形を残すなら、その compose
  仕様(coder のマウント一覧)を 05 に1節追加する。

## 4. ticket-source アダプタの契約が未定義

- FR-2.2 は「プラガブルなアダプタ(manual / github-issues / 独自追加)」を要求し、
  04 §4.6 は「`scripts/lib/ticket-sources/` のアダプタ名」とだけ書く。
  アダプタが実装すべき関数名・入力(チケットID? URL?)・出力(title/body/URL の
  形式)・失敗時の振る舞いがどこにも無い。
- **改善候補**: 04 に契約を1表で定義(例: `fetch_ticket <id-or-url>` → stdout に
  JSON `{id,title,body,url}`、非ゼロ exit で open-task は手入力へフォールバック)。
  `mrw task-up --from <link>`(06 §6.6)が同じ契約を使うことも明記。

## 5. `mrw doctor` の検査項目が未定義のまま FR に載っている

- FR-6.2 のサブコマンド列に `doctor` があるが、06 §6.9 は「設計が謳う水準
  (マウント監査 / egress セルフチェック / denyWrite 分岐チェック / config-discovery
  チェック)に**未達**」と現状を記すのみで、**その「設計が謳う水準」自体が
  パック内に存在しない**。再構築エージェントは doctor に何を実装すべきか決められない。
- **改善候補**: 06 に doctor の検査項目表(項目 / 合格条件 / fail 時の挙動)を追加。
  §6.9 の4分類 + 08 の機械化可能なチェック(includeIf 登録、フック実行可能性、
  telemetry 網 internal 検証)を昇格させると一貫する。

## 6. その他の小さな未仕様

- `templates/default/mcp.json` の内容・スキーマ(FR-2.3 の mcp_servers 検証が依存)。
- `.task-meta.json` / `.workspace-meta.json` のフィールド定義
  (list-task のフォールバック挙動が依存)。
- knowledge リポジトリの `sparse_paths` が purpose に無い場合の既定
  (04 §4.7 は「通常 checkout」とするが、`--no-checkout` で作った後の手順として
  明示されているか曖昧)。
- 承認ゲート文言(approve.ts の表示書式)。tri-state の「バイト同一ヘッダ」
  (05 §5.2)という検証条件があるため、ヘッダ書式は自由度ではなく仕様にすべき。
