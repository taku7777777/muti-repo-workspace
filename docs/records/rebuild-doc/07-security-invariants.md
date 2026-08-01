# 07 — セキュリティ不変条件(不可侵)

再構築のどのモード・どのフェーズでも**1つも手放してはならない**制約。
各項に根拠(なぜそうなっているか)を付す。番号は本パック内の参照用。

## INV-1 境界は OS / トポロジで fail-closed

アプリ内権限層(Claude Code permissions)は境界にしない。実測根拠: パススコープ deny の
不発、Read/Write/WebFetch/MCP/hooks によるサンドボックス迂回、`settings.local.json`
ドリフト(「今後確認しない」)による deny 再開通。ネイティブ経路 = macOS サンドボックス
(seatbelt)、コンテナ経路 = netns(`internal: true`)+ マウント。
**新しいロールを作る = 新しい OS 境界を作る。さもなければそのロールは存在しない。**

## INV-2 code 書込ロールの egress は固定インフラ read-allowlist に限定する

code 書込ロール(Coder/worker)には、汎用 egress・書込可能エンドポイント・exfil シンク
(github.com 系の fetch/push 区別不能な到達、sentry.io 等のマルチテナント exfil シンク)を
決して与えない。許されるのは機能に不可欠な固定インフラ(推論エンドポイント + パッケージ
レジストリ)への read-allowlist のみで、これはタスク都合(「この依存が要るから」)で拡張しない。
「例外なし」はこの**タスク都合での allowlist 追加**を指す。固定インフラの read-allowlist
自体は例外ではなく設計の一部である。境界マトリクスの 🚫 セルは、タスクレベルの外部到達
拡大と write-allowlist を禁止する。

## INV-3 publish 権限の単離

- git push / PR / publish はどのエージェントロールの能力でもない。
- コンテナ経路: **broker が唯一のトークン保持者**。worker は broker socket を持たず
  publish を**依頼すら**できない。orchestrator は typed intent を送れるだけ。
- ネイティブ経路: 唯一の監査済み経路 = `push-create-pr.sh`(orchestrator の
  `excludedCommands` 経由でのみ実行可能、両エージェント書込不可、push に
  `core.hooksPath` を強制、`--no-verify` を渡さない)。

## INV-4 broker は LLM フリー、人間の SHA 打鍵が唯一の権威承認

- broker 本体にモデル呼び出しなし(reviewer 諮問は別プロセスへの1本の typed socket call)。
- 承認 = broker が描画した12桁短縮 SHA の**打鍵**(`y` ではない。ボタン1押しに退化させ
  ない — Thread B でも維持)。
- reviewer の verdict は tri-state(off / no-verdict / verdict)の**助言のみ**。障害
  (`unavailable`)を承認と誤認させる表示は禁止。

## INV-5 broker は coder の言明を信用しない(F1〜F6)

1. **F1** — read 側 git は隔離環境(global/system config 無効化、トークン剥離、
   `--no-ext-diff --no-textconv`、argv 配列のみ)。coder のローカル `.git/config` は先に
   走査し、exec/リダイレクト可能キーで fail-closed(`untrusted_config`)。
2. **F2** — ポリシーは `BROKER_POLICY_FILE`(broker 所有)からのみ。欠落・不正・
   **coder 書込可能ツリー内に解決される**場合は fail-closed(両パス realpath 比較)。
   coder 書込可能な `config/workspace.json` はリクエスト時に決して読まない。強制は
   in-process(pre-push や jq に依存しない)。
3. **F3** — ground truth: 構築済み URL から broker 専用 scratch repo に fetch し、
   fetch したての ref(新ブランチは empty-tree)を base に diff を自前描画。
   ローカル `refs/remotes/*` を base にしない。全 git 呼び出し complete を assert、
   エラー/切り詰めはハード fail-closed(`render_incomplete`)。
4. **F4** — push 先は検証済み部品から**再構築した** `https://<host>/<org>/<repo>.git`。
   オブジェクトには sha(`GIT_ALTERNATE_OBJECT_DIRECTORIES`)で到達し、push は
   `<承認sha>:refs/heads/<branch>` ちょうど。coder の insteadOf / http.proxy /
   credential.helper は push をリダイレクトもトークン捕獲もできない。
5. **F5** — 直列・キャンセル安全な人間ゲート。1接続1 dispatch、busy はハンドラ全体で
   保持、承認待ちは独立予算 + AbortController、**失敗応答後に push しない**。
6. **F6** — push 直前に同期的再検証(config 再走査・ターゲット再解決・HEAD == 承認 sha。
   不一致は `sha_changed` で中止)。

## INV-6 push 先 allowlist の二重強制

- **authoritative**: broker が `allowed_push_orgs` / `allowed_push_hosts` を in-process
  強制(broker-policy.json。起動時 fail-closed + push ごと再検証)。
- **defence-in-depth**: pre-push フック(全リポジトリ/worktree に `core.hooksPath` +
  includeIf で適用)。**host チェックは常に最初に・org が空でも実施**
  (`https://evil.example/ALLOWED_ORG/repo` 型を遮断)。org 空は警告つき許可、
  host 不一致は無条件ブロック。URL パース不能もブロック。
- push ガード(broker in-process / pre-push)が参照するポリシーの解決は、worker が書込可能な
  いかなるパス(`tasks/` 配下・worktree 内コミットを含む)からも影響を受けてはならない。
  3実装が同一ポリシーを解決することを検証で保証する(機構は walk-up でも焼き込みでもよい)。

## INV-7 エージェントは自分の権限・通信・特権コードを変更できない

- worker の `sandbox.excludedCommands` は **`[]` を維持**(auto-allow 層に除外を1つでも
  足すと `<excluded>; <anything>` が行全体をサンドボックス外で走らせる — F9)。
- `agents/**`・`tasks/<T>/scripts/**`・toolHome の `.githooks/.claude/config/scripts/
  templates` は両エージェント denyWrite。denyWrite はあらゆる allow(settings.local.json
  ドリフト含む)に勝つ。
- 解決済み `config_dir` は worker / orchestrator 両方の denyWrite でピンする。legacy の
  `toolHome/config` だけでなく、workspace モードの `.mrw/` も同じ制御面として保護する。
- per-repo の git リダイレクト面(origin `.git/config`・`.git/hooks`・worktree の
  `config.worktree`)を denyWrite でピン(C-2 対策)。worktree ピンが解決できなければ
  設定生成は fail-closed。worker に origin `.git` への allowWrite は不要かつ禁止(S8-d /
  S2-o)。
- `.worker-target` は orchestrator 起動前にピンされ、denyWrite 配下、UUID 参照、
  スキルスクリプトは `--workspace`/`--surface` 上書きを拒否 — orchestrator は自分の
  worker としか話せない。
- タスクは自分のサンドボックスを広げられない。唯一の経路は root コンソールの
  `update-task-sandbox.sh`(push は決して付与しない)。
- コンテナ経路: worker への harness/scripts は `:ro`(自分のツール姿勢を定義するコードを
  書換不可)。broker/reviewer ソースはイメージ焼き込み(coder 書込可能ツリーからの
  改竄→再起動の供給経路を閉塞)。`TEST_COMMAND` はデーモン所有(RPC フィールド禁止)。

## INV-8 クレデンシャル単離

- worker / orchestrator: `~/.ssh` `~/.aws` `~/.config/gh` `~/.config/gcloud` `~/.npmrc` は
  denyRead + credentials deny + Read ルール deny の**二重遮断**。
- coder ケージに push クレデンシャルが存在しないこと自体をテスト(egress-selfcheck 第6項)。
- broker PAT はホストシェル per-run export → broker env のみ。`.env` ファイル禁止
  (coder の env_file に漏れる)。read 側 git からは剥離。
- Anthropic 認証は Keychain 由来のランタイム注入のみ。コミット・イメージ焼き込み禁止。
  compose は null-value passthrough(空文字の影潰しを防ぐ)。

## INV-9 品質ゲートは spine(コード)が持つ

1. テストの真偽は exit code(`status === 0`)のみ。モデルの主張は入力にならない。
2. publish intent は「plan + テスト green + 独立レビュー」がすべて**現在の HEAD sha** を
   証明するときのみ(ledger ゲート)。HEAD を動かす worker 実行は証明を無効化する。
3. 全ループ有界(fix 試行・worker 実行数・総アクション予算)。枯渇は fail-closed。
4. publish は broker socket 越しの typed intent のみ(orchestrator に Bash なし)。
5. 人間対話はスキップ不能・LLM 代答不能。spine が唯一の readline を所有し、EOF =
   fail-closed の decline。
6. 遷移規則自体はどのケージからも書換不能。

## INV-10 diff は harness が計算する(reviewer 盲目化の禁止)

レビュー・publish 承認に使う diff は常に `commitRangeDiff(baseSha..HEAD)`(git
オブジェクトの純粋読取)。coder が diff を供給することはない。不完全 diff
(`complete:false`)はハード停止。broker はさらに自前で ground truth を再描画する(F3)。

## INV-11 信頼できない入力は「データ」

- チケット本文・worker 出力・PR body・coder git config は指示ではなくデータ。
- 型付き schema(zod `.strict()`)・enum 語彙・in-code 交差(subset 制約)・サイズ上限で
  制約する。
- reviewer への coder title/body は UNTRUSTED ラベル付きで渡す(M3 のライブ検証で、
  注入指示入りの悪意 diff を reviewer が正しく `concerns` 判定した実績)。
- triage の `work_type` はテレメトリラベル(fail-open)だから外部由来を許す。
  **権威的なもの(push 先・ポリシー)へ拡張してはならない。**

## INV-12 テレメトリの分離と自己合成

- `OTEL_RESOURCE_ATTRIBUTES` は**ワイヤ越しに転送しない**。各セッションが検証済みの値
  (`SAFE_ATTR_VALUE = /^[A-Za-z0-9._-]{1,100}$/`)から自己合成。不正値は `unlabeled` に
  **拒否**(strip による改変はしない — ラベル衝突/構文注入防止)。
- `mrw-telemetry` 網は `internal: true` 必須。参加は worker / orchestrator / reviewer
  のみ。broker / egress-proxy は不参加。
- テレメトリは fail-open(collector 不在 = 無音ノーオペ)。publish 経路とは逆の姿勢で
  あることを混同しない。

## INV-13 egress は allowlist + トポロジ

- Squid allowlist(`api.anthropic.com` + `registry.npmjs.org`)。github.com 系は
  **意図的に不許可**(allowlist は fetch と push を区別できない)。`sentry.io` は
  決して追加しない(マルチテナント exfil シンク)。
- セキュリティはトポロジ(`internal: true`)であり、proxy 遵守は利便性。
- ケージに NET_ADMIN/NET_RAW なし(`cap_drop: [ALL]`)、外部 DNS なし。
- WebSearch はサーバサイド実行のためネットワークで殺せない — アプリ層 deny が唯一の
  制御であることを認識し続ける(Phase 4 まで)。

## INV-14 生成物の規律

- 生成ファイル(`tasks/**`、`.claude/settings.json`、`repositories/*/.claude/`)は
  手編集しない。テンプレート変更 → スキル/スクリプト再実行。
- 絶対パスをコミットしない。`{{...}}` プレースホルダはランタイム置換のみ。
- `excludedCommands` ↔ 生成 CLAUDE.md のパスはバイト一致(同一 env からの単一 render
  パスで構成的に保証)。

## 既知の「認めた上での」限界(不変条件ではないが正直に維持する記録)

- **C-3**: ネイティブ orchestrator は半信頼(`$(...)` が excludedCommands 行内で
  サンドボックス外実行される)。コンテナ経路では構造的に存在しない。
- Phase 0 の egress はドメイン allowlist であり L7 ではない(domain-fronting・
  DNS トンネルの残余、トークンが `docker inspect` で可視 — Phase 4 スコープ)。
- reviewer の egress allowlist は coder と共有(専用の狭い allowlist は Phase 4)。
- npm registry 経由のケージ内サプライチェーン(悪意あるパッケージの install script が
  ケージ内で実行されうる)は、ケージ内に秘密情報が無いことと egress 制限により影響半径を
  限定した、認めた上での許容済み残余リスクである。
- telemetry 網への偽データ/洪水は許容リスク(影響半径 = ローカル監視のみ)。
