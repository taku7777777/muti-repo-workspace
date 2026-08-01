# 02 — 要求仕様
日付: 2026-07-17(2026-08-02 の §12.1 移行で遡及付与。値はファイルの最終更新時刻 —— 初版コミットは保存と同日のため)

再構築システムが満たすべき要求。**FR** = 機能要求、**NFR** = 非機能要求、**SEC** = セキュリティ要求。
SEC の詳細な不変条件は [07-security-invariants.md](07-security-invariants.md) が正典。

## 2.1 機能要求(FR)

### FR-1 ワークスペースのセットアップ
- FR-1.1 `config/repos.json` に列挙された対象リポジトリを `repositories/<name>` にクローンできる。
- FR-1.2 セットアップは**冪等**であり、config 変更後に何度でも再実行できる。
- FR-1.3 各レイヤ(root / repositories)のサンドボックス設定、pre-push フック
  (`core.hooksPath` + `~/.gitconfig` includeIf)、cmux ヘルパをテンプレートから生成・導入する。
- FR-1.4 生成ファイルは決して手編集しない。テンプレート変更 → スキル再実行で再生成する。

### FR-2 タスクライフサイクル
- FR-2.1 チケット1件につき独立したワークスペース `tasks/<TICKET>/` を作成できる
  (open-task)。内容: 対象リポジトリの git worktree(ブランチ `<branch_prefix><TICKET>`)、
  worker + orchestrator の2エージェント、cmux 3タブ(Worker / Terminal / Orchestrator)。
- FR-2.2 チケット取得はプラガブルなアダプタ(`manual` / `github-issues` / 独自追加)で行う。
- FR-2.3 purpose(`config/purposes/*.json`)により初期リポジトリ・MCPサーバ・テンプレートを
  切り替えられる。JSON を1つ置けば purpose が1つ増える。
- FR-2.4 タスクの一覧(list-task)・削除(close-task。未 push 作業があれば拒否)・
  再開(start-task)・リポジトリ追加(add-repository)ができる。
- FR-2.5 タスクの worker サンドボックス拡張は root コンソールの専用スクリプト経由でのみ
  可能(update-task-sandbox)。push 権限はこの経路でも付与しない。

### FR-3 worker / orchestrator 協調(ネイティブ経路)
- FR-3.1 worker はサンドボックス内でゼロプロンプトに編集・ビルド・テスト・コミットする。
- FR-3.2 orchestrator は cmux 経由で worker に指示を送り、待機し、結果を読む。
  通信対象は生成時にピン留めされた自分の worker のみ。
- FR-3.3 両者は追記専用の handoff ログ(`docs/handoff/`)で状態を交換する。
  状態は常にファイルから導出可能(可変状態ファイルなし)。仕様は [04](04-native-path.md) §4.4。
- FR-3.4 worker は特権行為(push・PR・パッケージ導入)を自分で試みず、handoff で依頼して
  idle になる。worker は exit せず、idle が「次の指示待ち」シグナル。
- FR-3.5 push / PR 作成は唯一の監査済みスクリプト `push-create-pr.sh` 経由
  (orchestrator または人間が実行)。

### FR-4 コンテナ経路(5サービス)
- FR-4.1 compose で worker / orchestrator / broker / reviewer / egress-proxy の5サービスを
  起動できる。仕様は [05](05-container-path.md)。
- FR-4.2 worker はタイプ付き RPC デーモン(workerd)として
  `setup_worktree` / `run_implement` / `run_fix` / `run_tests` を提供し、
  各ステップ後に**決定的な `mrw:` プレフィクスコミット**を行う。
- FR-4.3 orchestrator はコード化された spine(不変条件 ledger + タイプ付きアクション
  executor)の上で LLM セッションを走らせる(`npm run chat`)。LLM は1回に1つの
  タイプ付きアクションを提案するだけで、実行は spine が行う。
- FR-4.4 broker は LLM フリーの publish ゲート。タイプ付き intent を受け、ground truth
  (diff・URL・sha)を自前で再導出し、人間が **短縮 SHA を打鍵**して初めて push + PR 作成する。
- FR-4.5 reviewer は任意有効化の助言専用レビュー(tri-state: off / no-verdict / verdict)。
  broker の SHA ゲートの表示に1行加わるのみで、承認権限は持たない。
- FR-4.6 `WORKERD_SOCKET` 未設定時は同一プリミティブによる単一プロセスフォールバックで
  動作する(分割トポロジと単一コーダは1つのコードベース)。
- FR-4.7 クラシックな `npm run orchestrate`(単一リポジトリ)/ `npm run drive`
  (1チケット×Nリポジトリ、resumable、正直な部分成功レポート)も同じプリミティブで動く。

### FR-5 テレメトリ
- FR-5.1 3つの LLM ケージ(worker / orchestrator / reviewer)は第2の internal 専用網
  `mrw-telemetry` に参加し、per-ticket の OTEL 属性
  `workspace=<ticket>,work_type=<type>,role=<role>` を **各セッションが自己合成**して送出する。
- FR-5.2 属性文字列をコンテナ間で転送しない。検証済みの値からのみ合成し、不正値は
  `unlabeled` に**拒否**(サニタイズによる改変はしない)。
- FR-5.3 テレメトリは fail-open(collector 不在でも無音でノーオペ、ステップを止めない)。
  broker と egress-proxy は telemetry 網に参加しない。

### FR-6 mrw CLI と状態外部化
- FR-6.1 `repositories/` + `tasks/` 相当の状態を config の `state_root`(絶対パス)で
  任意ディレクトリに外部化できる。`state_root` 空 = 従来とバイト単位で同一挙動
  (完全後方互換)。
- FR-6.2 `mrw` は依存ゼロの単一 plain-ESM Node スクリプトで、`import.meta.url` から
  toolHome を解決し、どの cwd からでも実行できる。サブコマンド: `config` / `init` /
  `setup` / `infra-up` / `infra-down` / `task-up` / `list` / `close` / `doctor`。
- FR-6.3 per-workspace config `.mrw/`(workspace.json, repos.json, purposes/,
  broker-policy.json)を `mrw init [dir]` で雛形生成でき、複数ワークスペースを並走できる。
  config 解決は3実装(common.sh / pre-push / mrw.mjs)で一致する。
- FR-6.4 `mrw task-up --from <link>` はチケット取得 → **read-only 型付き triage leaf**
  (LLM 分類: `{work_type, title, repos, summary}`)→ title/repos の自動補完を行う。
  triage 失敗(認証・gh・API)でもタスク作成は止めない(graceful degradation)。
- FR-6.5 compose は config からパラメータ化され(`MRW_STATE_ROOT` / `MRW_CONFIG_DIR`)、
  broker-policy はイメージ焼き込みではなくランタイム `:ro` バインドで供給される。

### FR-7 品質ゲート(コンテナ経路の publish 前提)
- FR-7.1 テストの真偽は exit code のみ(`status === 0`)。モデルの主張は入力にならない。
- FR-7.2 publish intent は「plan + テスト green + 独立レビュー承認」の3つ全部が
  **現在の HEAD sha** を証明している場合のみ発火する(ledger ゲート)。
  HEAD を動かす worker 実行は既存の証明を無効化する。
- FR-7.3 すべてのループは有界(fix 試行、worker 実行数、総アクション予算)。
  枯渇は fail-closed。
- FR-7.4 diff がテストファイルに触れている場合(`diffTouchesTests`)、publish ゲートは
  追加の明示的な人間 ack を要求する。

## 2.2 非機能要求(NFR)

- NFR-1 **ゼロプロンプト UX**: worker は境界内で確認プロンプトなしに動作する。
  安全性の根拠はプロンプトではなく OS 境界。
- NFR-2 **冪等性**: setup-workspace、mrw init、telemetry 網作成などの構成操作は再実行安全。
- NFR-3 **再開可能性**: driver は `phase3-state.json`(atomic temp+rename)で再開でき、
  published 済みリポジトリをスキップする。spine ledger も毎 dispatch 後に atomic 永続化。
- NFR-4 **正直な報告**: N リポジトリの原子性は不可能である事実を隠さない。途中失敗で停止し、
  published / stopped / not-attempted の完全な台帳を印字する。無音の部分成功禁止。
- NFR-5 **fail-closed / fail-open の使い分け**: publish・サンドボックス・ポリシー読込は
  fail-closed。テレメトリと triage は fail-open(本体機能を止めない)。
  pre-push フックのみ「config ファイル不在/jq 不在」で fail-open(ユーザー締め出し防止)+警告。
  config の不正 JSON・相対パス・正規化失敗は fail-closed。
- NFR-6 **テスト**: ユニットテストは依存最小(bash ランナー + `node:test`)。
  スイート構成が [05](05-container-path.md) §5.7 と一致して全 green であること(実績の
  harness 81 / shell 40 / reviewer 8 という数は参考値)。セキュリティ境界
  (validate_ticket_id、pre-push、protocol schema、ledger ゲート)は必ずテストする。
- NFR-7 **ドキュメント**: 英語を正、`.ja.md` を対で提供(architecture / handoff-protocol /
  settings-reference / verification-guide / devcontainer-*)。設計と実態の乖離を残さない。
- NFR-8 **可搬性**: 生成ファイルに絶対パスをコミットしない。プレースホルダ
  `{{...}}` はランタイム置換のみ。worktree リンクは相対ターゲットで移動に耐える。
- NFR-9 **コスト帰属**: 全セッションに OTEL `workspace=` ラベル(ROOT / REPOSITORIES /
  チケットID)。

## 2.3 セキュリティ要求(SEC — 要約)

詳細・根拠は [07-security-invariants.md](07-security-invariants.md)。ここでは分類のみ:

- SEC-1 境界は OS / ネットワークトポロジで fail-closed(アプリ内権限は境界ではない)。
- SEC-2 `code` 書込ロールの egress は、推論エンドポイント + パッケージレジストリへの
  固定インフラ read-allowlist のみに限定する。タスクレベルの到達拡大、書込可能
  エンドポイント、exfil シンクは決して与えない(境界マトリクスの 🚫 セル)。
- SEC-3 publish 権限は broker(コンテナ)/ push-create-pr.sh + pre-push(ネイティブ)に
  単離。worker は publish を**依頼すら**できない(broker socket を持たない)。
- SEC-4 broker は LLM フリー。人間の SHA 打鍵が唯一の権威承認。coder の言明は信用せず
  ground truth を自前で再導出(F1〜F6)。
- SEC-5 `allowed_push_orgs` / `allowed_push_hosts` は broker が in-process で強制
  (authoritative)、pre-push フックは defence-in-depth。host チェックは常に先・必須。
- SEC-6 エージェントは自分のサンドボックス・特権スクリプト・通信ピンを改変できない
  (denyWrite、イメージ焼き込み、`.worker-target`)。
- SEC-7 クレデンシャルの単離: worker/orchestrator はシークレットを読めない。
  push トークンは broker のみ、read-side git からは剥離。Anthropic 認証は Keychain 由来の
  ランタイム注入のみ(コミット・焼き込み禁止)。
- SEC-8 信頼できない入力(チケット本文・worker 出力・coder の git config・PR body)は
  常に「データ」として扱い、型付き schema・enum・in-code 交差で制約する。

## 2.4 要求トレーサビリティ(正典)

各要求の実装仕様と受け入れ検証。範囲表記は、その節の全サブ項目に適用する。

| 要求 | 仕様参照 | 検証参照 |
|---|---|---|
| FR-1.1 | 04 §4.1 setup | 08 Step 1 |
| FR-1.2 | 04 §4.1 setup | 08 Step 0〜1 |
| FR-1.3 | 04 §4.1〜4.3, §4.5, §4.8 | 08 Step 1〜3 |
| FR-1.4 | 04 §4.2 | 08 Step 0, 2 |
| FR-2.1 | 04 §4.1 open-task, §4.2, §4.7〜4.8 | 08 Step 2〜3 |
| FR-2.2 | 04 §4.6 ticket-source | 08 Step 2a |
| FR-2.3 | 04 §4.2, §4.6 purposes/MCP | 08 Step 2a |
| FR-2.4 | 04 §4.1 list/close/start/add | 08 Step 3, 6 |
| FR-2.5 | 04 §4.1 update-task-sandbox, §4.3 | 08 Step 5, §8.3 INV |
| FR-3.1 | 04 §4.3〜4.4 | 08 Step 3〜5 |
| FR-3.2 | 04 §4.3 pinned target, §4.8 | 08 Step 3, 5 |
| FR-3.3 | 04 §4.4 | 08 Step 3 |
| FR-3.4 | 04 §4.2 template指示, §4.4 | 08 Step 3 |
| FR-3.5 | 04 §4.1 create-pr, §4.3, §4.5 | 08 Step 4〜5 |
| FR-4.1 | 05 §5.0〜5.1 | 08 §8.2-1〜3 |
| FR-4.2 | 05 §5.3 workerd | 08 §8.2-5〜6 |
| FR-4.3 | 05 §5.3 spine | 08 §8.2-6 |
| FR-4.4 | 05 §5.2 | 08 §8.2-7 |
| FR-4.5 | 05 §5.1 reviewer, §5.2 tri-state | 08 §8.2-7, §8.3 smoke |
| FR-4.6 | 05 §5.3 exec.ts | 08 §8.2-9 |
| FR-4.7 | 05 §5.3 driver, §5.6 | 08 §8.2-10 |
| FR-5.1 | 05 §5.1 network, §5.3 telemetry | 08 §8.2-4, 8 |
| FR-5.2 | 05 §5.3 telemetry | 08 §8.2-5, 8 |
| FR-5.3 | 05 §5.1, §5.3 telemetry | 08 §8.2-8 |
| FR-6.1 | 06 §6.1, §6.3 | 08 §8.2a-3, §8.3 |
| FR-6.2 | 06 §6.4, §6.9 | 08 §8.2a, §8.3 |
| FR-6.3 | 05 §5.0; 06 §6.2, §6.5 | 08 §8.2a-1〜2 |
| FR-6.4 | 06 §6.6 | 08 Step 2a, §8.3 triage |
| FR-6.5 | 05 §5.0〜5.1; 06 §6.3 | 08 §8.2-1〜4, §8.2a |
| FR-7.1 | 05 §5.3 gates | 08 §8.2-5〜6 |
| FR-7.2 | 05 §5.3 ledger | 08 §8.2-6〜7 |
| FR-7.3 | 05 §5.2 timeout, §5.3 budgets | 08 §8.2-5〜7 |
| FR-7.4 | 05 §5.3 diffTouchesTests | 08 §8.2-6〜7 |
| NFR-1 | 03 §3.1〜3.3; 04 §4.3 | 08 Step 3〜5, §8.2-2〜3 |
| NFR-2 | 04 §4.1, §4.7; 05 §5.1; 06 §6.4〜6.5 | 08 Step 0〜2, §8.2-1, §8.2a |
| NFR-3 | 05 §5.3 ledger/driver | 08 §8.2-10 |
| NFR-4 | 05 §5.3 driver | 08 §8.2-10 |
| NFR-5 | 04 §4.5; 05 §5.1〜5.5; 06 §6.2 | 08 Step 4〜5, §8.2-2〜8 |
| NFR-6 | 04 §4.9; 05 §5.7 | 08 Step 0, §8.2-5 |
| NFR-7 | 10 R9 | 10 R9 docs-only 再実行ゲート |
| NFR-8 | 04 §4.2, §4.7; 06 §6.3 | 08 §8.2a-3 |
| NFR-9 | 04 §4.3; 05 §5.3 telemetry | 08 §8.2-8 |
| SEC-1 | 03 §3.1; 07 INV-1 | 08 Step 5, §8.2-2〜4, §8.3 INV |
| SEC-2 | 03 §3.6; 05 §5.4; 07 INV-2 | 08 §8.2-2〜3, §8.3 INV |
| SEC-3 | 04 §4.3〜4.5; 05 §5.1〜5.2; 07 INV-3 | 08 Step 4〜5, §8.2-3, 7 |
| SEC-4 | 05 §5.2; 07 INV-4〜6 | 08 §8.2-7, §8.3 INV |
| SEC-5 | 04 §4.5; 05 §5.2; 07 INV-5〜6 | 08 Step 0, 4; §8.2-7 |
| SEC-6 | 04 §4.3; 05 §5.1, §5.5; 07 INV-7〜8, 13〜14 | 08 Step 2〜5, §8.2-3, §8.3 INV |
| SEC-7 | 04 §4.3; 05 §5.5; 07 INV-8 | 08 Step 5, §8.2-2〜3, 7 |
| SEC-8 | 04 §4.6; 05 §5.2〜5.3; 07 INV-9〜11 | 08 Step 2a, §8.2-5〜7, §8.3 smoke |
