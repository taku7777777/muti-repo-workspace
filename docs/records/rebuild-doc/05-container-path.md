# 05 — コンテナ経路(devcontainer)実装仕様
日付: 2026-07-17(2026-08-02 の §12.1 移行で遡及付与。値はファイルの最終更新時刻 —— 初版コミットは保存と同日のため)

> 対象: `.devcontainer/` + `docker/egress/` + `broker/` + `reviewer/` + `harness/`。
> macOS サンドボックスを Linux コンテナ(netns 境界)に置換した経路。
> devcontainer は `orchestrator` サービスにアタッチ。compose プロジェクト名は §5.0 の
> モード別規則で決定する。

## 5.0 共通事項

- `scripts/lib/common.sh` の `compose_project_name()` が compose プロジェクト名を決める。
  legacy mode(`.mrw/` 未使用の既定ワークスペース)では既存コンテナ・volume を孤立させない
  後方互換のため常に **`mrw-phase0`**。workspace mode(per-workspace `.mrw/`)では、
  ワークスペースごとに一意な `config_base()` の正規化済み絶対パスを SHA-256 にかけ、
  先頭12桁から **`mrw-<hash12>`** を決定的に導出する。
- `docker compose` を呼ぶ全スクリプト(`infra-up`/`infra-down`/close purge を含む)は、同じ
  関数の結果を `COMPOSE_PROJECT_NAME` に設定してから compose を呼ぶ。この環境変数は
  compose ファイルの `name:` より優先される。これによりコンテナ、既定ネットワーク、
  named volume をワークスペース単位で分離する。共有 external 網 `mrw-telemetry` は対象外。

- 全サービス `user: node`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`。
- ベースイメージ: coder/broker/reviewer は Node 20
  (`mcr.microsoft.com/devcontainers/typescript-node:20`)、egress-proxy は Alpine 3.20。
- ソケット類は **named volume** で共有(Docker Desktop macOS ではホストパスバインドの
  unix socket がコンテナ境界を越えられないため)。named volumes:
  `broker-sock` / `worker-sock` / `reviewer-sock` / `review-diffs` / `spine-notes`。
- harness の依存は named volume にしない(`:ro` バインド上に volume を被せるとホストの
  darwin/uid 不一致 node_modules から初期化され EACCES)。各ケージは
  `scripts/prepare-harness-run.sh` でソースをコンテナローカル `/home/node/harness-run` に
  コピーして `npm ci` する。**ハーネス変更後は orchestrator 内で prepare 再実行 +
  `docker compose restart worker` が必要**。
- healthcheck は「ソケットが listen していること」を検証(`test -S <sock>`)。
  `depends_on: service_healthy` が実際に接続可能になるまでブロックする。

## 5.1 5サービストポロジ

### worker(write:code × egress:anthropic-only)
- build: `.devcontainer/coder.Dockerfile`(orchestrator と共用。base + jq + gh +
  グローバル `@anthropic-ai/claude-code`。`/run/worker` と `/var/mrw/notes` を node 所有で
  事前作成 — 新規 named volume の EACCES 回避)。
- networks: `caged`(internal)+ `telemetry`。**`egress` には居ない** → インターネット・
  GitHub 到達不可。
- mounts: `${MRW_STATE_ROOT:-..}/tasks` → `/workspaces/muti-repo-workspace/tasks` **rw**
  (唯一の書込面)。`repositories` **:ro**(clone `--reference` の origin。破壊不可に)。
  `../harness` **:ro** + `../scripts` **:ro**(デーモンのソースは自己書換不可 — 注入された
  LLM が自分のツール姿勢を再武装できない)。`worker-sock` → `/run/worker`。
  **broker-sock は持たない。**
- env: `WORKERD_SOCKET_PATH=/run/worker/workerd.sock`、
  `MRW_WORKSPACE_ROOT=/workspaces/muti-repo-workspace`(コンテナローカルコピーで動くため
  ルート解決をピン)、`TEST_COMMAND`(**デーモン所有。RPC フィールドにしない** — 注入された
  orchestrator がシェルコマンドをワイヤ越しに密輸できない)、proxy 変数、
  `NO_PROXY` に `otel-collector` を含む、`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`
  (null-value passthrough)。`OTEL_RESOURCE_ATTRIBUTES` は意図的に**設定しない**(自己合成)。
- command: `prepare-harness-run.sh && cd /home/node/harness-run && exec npm run workerd`。
  healthcheck `test -S /run/worker/workerd.sock`、`start_period: 300s`(proxy 越し cold npm ci)。

### orchestrator(判断プレーン・人間の対話面)
- build: 同じ coder.Dockerfile。**worker との分離はイメージ差ではなく、マウント/ソケットの
  列挙差のみで強制**される。
- networks: `caged` + `telemetry`。
- mounts: `..` → ワークスペース全体 **:ro**(マウントレベルの1事実が境界)。ネストの
  `tasks`/`repositories` も **:ro** オーバレイ。`spine-notes` → `/var/mrw/notes` **rw**
  (ledger/notes。worker が書ける tasks/ ツリーから意図的に隔離)。
  `broker-sock` → `/run/broker`(broker 以外で唯一の保持者)。`worker-sock` → `/run/worker`。
- env: `BROKER_SOCKET=/run/broker/publish.sock`(唯一の publish 経路)、
  `WORKERD_SOCKET=/run/worker/workerd.sock`、`MRW_STATE_DIR=/var/mrw/notes`、
  `MRW_WORKSPACE_ROOT`、proxy、クレデンシャル passthrough。
- command: `prepare-harness-run.sh || echo FAILED; exec sleep infinity`(失敗を可視化しつつ
  人間の exec-in のため生存)。`stdin_open`/`tty` あり。depends_on: egress-proxy + broker +
  worker すべて `service_healthy`。

### broker(push できる唯一のコンポーネント)
- build: `.devcontainer/broker.Dockerfile`。Node 20 + gh + git。**ビルド時に焼き込み**:
  npm 依存(zod, tsx, typescript)と `broker/src`(書込ビット剥奪 `chmod a-w`)。
  ソースはマウントしない(ホストの `../broker/src` は coder 書込可能ツリー内 →
  改竄→再起動の供給経路になる)。`/etc/mrw-broker` は root 所有で作成。
- networks: **`egress` のみ**(GitHub 到達)。caged にも telemetry にも居ない。
- mounts: `${MRW_CONFIG_DIR:-../config}/broker-policy.json` → `/etc/mrw-broker/policy.json`
  **:ro**(de-bake された信頼ポリシー。再ビルド不要で編集可、なお broker 所有・coder ツリー外)。
  `broker-sock`、`reviewer-sock` → `/run/reviewer`、`review-diffs` → `/var/mrw/review-diffs`
  **rw**、ワークスペース `..` **:ro** + ネスト `tasks`/`repositories` **:ro**
  (sha でオブジェクトを読むだけ。実行しない)。
- env: `BROKER_GITHUB_TOKEN`(ホストシェル補間で broker env のみ。**env_file 禁止**)、
  `BROKER_POLICY_FILE=/etc/mrw-broker/policy.json`、`BROKER_WORKTREES_DIR`
  (既定 `/workspaces/.../repositories`)、`BROKER_CODER_TREE=/workspaces/muti-repo-workspace`、
  `BROKER_SOCKET_PATH=/run/broker/publish.sock`、`GIT_TERMINAL_PROMPT=0`、
  `REVIEWER_SOCKET`(null-passthrough。未設定 = reviewer 機能 OFF)、
  `REVIEWER_DIFF_DIR=/var/mrw/review-diffs`。
- command: `npm start`。`stdin_open`/`tty`(この stdin が人間承認ゲート)。
  **`depends_on: reviewer` は無し**(reviewer は任意・fail-visible)。

### reviewer(M3、任意有効化・助言のみ)
- build: `.devcontainer/reviewer.Dockerfile`。Node 20、**gh なし・git なし**。
  依存 + `reviewer/src` を焼き込み(書込剥奪)。ワークスペース無マウント。
- networks: `caged` + `telemetry`(現状 coder と同じ allowlist を共有。reviewer 専用の
  より狭い allowlist は Phase 4 スコープ)。
- mounts: `reviewer-sock` → `/run/reviewer`(自分が listen)、`review-diffs` **:ro**
  (broker が書き reviewer は読むだけ)。
- env: `REVIEWER_SOCKET_PATH=/run/reviewer/review.sock`、`REVIEWER_DIFF_DIR`、
  クレデンシャル passthrough、`REVIEWER_MODEL`(既定 `sonnet`)、
  `REVIEWER_SESSION_TIMEOUT_MS`(既定 120000)。
- command: `npm start`。healthcheck `test -S /run/reviewer/review.sock`、
  `start_period: 60s`(焼き込み済みなのでランタイム npm ci なし)。

### egress-proxy(唯一の外向き経路)
- build: `../docker/egress`(Alpine + squid)。非特権 `squid` ユーザー、port 3128
  (>1024 で NET_BIND_SERVICE 不要)。config + allowlist は root 所有 read-only で焼き込み。
- networks: `caged` + `egress` の二重ホーム。healthcheck = `pidof squid`。

### ネットワークと不変条件
- **`caged`**: `internal: true` — ホスト/インターネットへの経路なし。**トポロジで
  fail-closed**: proxy を無視するツールにはパケットの行き先がない。
- **`egress`**: bridge。proxy と broker のみ。どちらのケージも居ない。
- **`telemetry`** = `name: mrw-telemetry`, `external: true` — compose 外で
  `devcontainer-up.sh` が冪等作成する第2の `internal: true` 網
  (`docker network create --internal mrw-telemetry`)。参加: worker / orchestrator /
  reviewer。**不参加: broker / egress-proxy**。隣接する監視スタックの
  `otel-collector:4317` のみに到達。fail-open 設計(許容リスク: ケージが偽データ/洪水を
  ローカル collector に送る — 影響半径はローカル監視のみ)。

## 5.2 broker(LLM フリーの publish ゲート)

`broker/src/{index,server,config,handler,git,approve,reviewer,types}.ts`。
独立 npm パッケージ(依存は zod のみ、tsx で実行)。**1接続 = 1リクエスト、構造的に直列**。

### ソケットプロトコル
- unix socket、`chmod 0666`(world-writable — これは何も認可しない。全リクエストが
  再検証 + 人間ゲートされる)。
- フレーミング: 改行終端 JSON の `PublishRequest` を1接続に1つ。応答も改行終端 JSON の
  `PublishResponse` を1つ返して close。
- `PublishRequest`(zod `.strict()`): `{repo: bare-name, branch, title(1..1024),
  body(≤64KiB)}`。これは **intent(願望)であり、信用する diff ではない** — broker が
  ground truth を自前で描画する。
- `busy` はハンドラ全体(検証 + 人間ゲート + push)で保持。busy 中の2本目の接続は即
  `busy` 応答。タイムアウト分離: `READ_TIMEOUT_MS=30s` はリクエスト読取のみを束縛。
  dispatch 後は解除され、別の `APPROVAL_TIMEOUT_MS`(既定30分、
  `BROKER_APPROVAL_TIMEOUT_MS`、0 = 無制限)が AbortController 経由で承認待ちを
  キャンセルし `canceled` を返す。クライアント切断も abort → **失敗応答後に push しない**。
- `PublishErrorCode`(すべて fail-closed、既定 = 「publish しなかった」):
  `invalid_request, config_missing, repo_not_allowed, worktree_missing, untrusted_config,
  detached_head, branch_mismatch, branch_not_allowed, dirty_worktree, remote_unparseable,
  host_not_allowed, org_not_allowed, fetch_failed, render_incomplete, nothing_to_publish,
  declined, canceled, sha_changed, push_failed, pr_failed, busy`。

### publish フロー(handler.ts。順序が重要、全分岐 fail-closed)
1. typed request をパース(coder の形を信用しない)。
2. 信頼ポリシーを fail-closed に読込(F2)。
3. `<WORKTREES_ROOT>/<repo>` を解決し、ルート内に留まることを証明。worktree に `.git` 必須。
4. **coder のローカル git config を走査**(`scanUntrustedLocalConfig`)— status/log/diff を
   1つでも実行する**前に**、exec/リダイレクト可能キーがあれば fail-closed
   (`untrusted_config`)。拒否リスト正規表現 `DANGEROUS_CONFIG`:
   `filter.*.(clean|smudge|process)`、`core.(fsmonitor|hookspath|sshcommand|askpass|pager|
   editor|...)`、`url.*.(insteadof|pushinsteadof)`、`http.*`、`credential.*`、
   `diff.*.(command|textconv)`、`gpg.*`、`ssh.variant`、`protocol.*`、`uploadpack.*`、
   `receivepack.*`、`init.templatedir`、`include.path`、`includeif.*`。
5. 実際のブランチ/HEAD/クリーン性を git から解決(F1 隔離環境で)。detached HEAD 拒否、
   `req.branch === 実ブランチ` 必須、`branch_prefix` で始まること必須、dirty
   (`status --porcelain` 非空)拒否。
6. `origin` をパース → host を `allowed_push_hosts`、org を(非空なら)`allowed_push_orgs`
   に対し **in-process 検証** → 検証済み部品から**正規 URL を再構築**
   `https://<host>/<org>/<repo>.git`(F4。生の origin 文字列は使わない — 埋め込み
   クレデンシャル・insteadOf 形・余分なパスセグメントを無効化)。
7. **ground truth 描画(F3)**: broker 専用の使い捨て bare scratch repo を作成
   (`init.templateDir=` 空)、coder のオブジェクトには sha 経由
   (`GIT_ALTERNATE_OBJECT_DIRECTORIES`)で到達(content-addressed = sha で信用、
   coder config は決して信用しない)。構築済み URL から `ls-remote` →
   `fetch +refs/heads/<branch>:refs/broker/base`。base(fetch したての tip、新ブランチなら
   `EMPTY_TREE 4b825dc…`)`..sha` の diff を描画。全 git 呼び出しは `ok && !truncated` を
   assert — エラー/maxBuffer 溢れは**ハード fail-closed**(切り詰められた「ground truth」を
   見せない)。未 push 0 かつ diff 空なら `nothing_to_publish`。
8. (任意)reviewer 諮問(下記 tri-state)。
9. **broker での人間承認**(approve.ts): ground-truth 要約 + 構築済みターゲット + sha +
   reviewer verdict を提示。
10. **F6: push 直前の再検証**(同期的、チェックと push の間に await なし): config 再走査、
    ターゲット再解決・再検証(URL 変化なら中止)、`headSha` 不変を再確認(変化 =
    `sha_changed` — replay/TOCTOU ガード)、`signal.aborted` 確認。
11. `pushApprovedSha`: 承認された sha **ちょうど**を `<sha>:refs/heads/<branch>` として
    構築済み URL へ scratch repo から push。次に `gh pr create --repo <org>/<repo>
    --head <branch> --title/--body`(argv 配列、シェル文字列禁止。enterprise は `GH_HOST`)。
    `{ok:true, sha, branch, prUrl}` を返す。

### 人間の SHA 承認(approve.ts)
- broker コンテナの stdin/stdout(`docker compose attach broker`)。coder はこのプロンプトに
  到達できない。**Ctrl-C は broker を殺す。デタッチは Ctrl-p Ctrl-q**。
- **無音の切り詰めなし**: full diff を `PAGE_LINES=400` 行ずつページング。全部見るか `q` で
  打ち切り(打ち切りは caveat として記録)。
- **承認は SHA 束縛**: broker が描画した12桁短縮 sha を**正確に打鍵**(`y` ではない)。
  AbortSignal でキャンセル可能。
- 承認ヘッダのバイト列は仕様であり自由度ではない。reviewer OFF 時のヘッダは、順に
  `=== MRW BROKER PUBLISH APPROVAL ===`、`Target: <url>`、`Branch: <branch>`、
  `Commit: <sha12>`、`Type the commit SHA (<sha12>) to approve:` を改行区切りで表示する。
  reviewer 有効時だけ `Commit:` と入力要求の間に §5.2 の advisory 1行を挿入する。

### reviewer 統合(tri-state 助言)
- `maybeConsultReviewer(diff, title, body, signal)` は `ReviewerVerdict | "unavailable" |
  null` を返し**決して throw しない**。`REVIEWER_SOCKET` 未設定 ⇒ `null`(機能 OFF)。
  あらゆる失敗(接続・タイムアウト `REVIEWER_TIMEOUT_MS` 既定120s・`ok:false`・不正形)⇒
  `"unavailable"`(1行ログ)。小 diff(`INLINE_THRESHOLD_BYTES=64KiB`)はインライン送信、
  大きい場合は `REVIEWER_DIFF_DIR` に `<uuid>.diff` を書きパス参照(finally で unlink)。
- **tri-state 表示**: `null` → 何も描画しない(M3 以前とバイト同一ヘッダ)/
  `"unavailable"` → 明示的な「no verdict(reviewer 失敗/タイムアウト — diff だけで判断せよ)」
  行(**障害を承認と誤認させない**)/ verdict → `approve — <notes>` or `CONCERNS — <notes>`
  (notes は1行に折り畳み、モデルタグ断片を除去、500字上限)。
- verdict は**助言のみ** — SHA 打鍵ゲートを決して変えない。

### トークン取り扱い(git.ts)
- `GITHUB_TOKEN` は `BROKER_GITHUB_TOKEN ?? GH_TOKEN ?? GITHUB_TOKEN`(broker env のみ)。
- **2つの厳密分離された世界**。read 側(`isolatedEnv`): global/system config 無効化
  (`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_SYSTEM=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`)、
  トークン剥離(GH_TOKEN 等4種を delete)、`GIT_ASKPASS/SSH_ASKPASS` delete、プロンプト
  off、pager 無効化、`-c core.fsmonitor=false`、diff には `--no-ext-diff --no-textconv`。
  network 側(`netEnv`): トークン + object alternates を再付与。トークンは
  `$MRW_BROKER_GH_TOKEN` を読むインライン credential helper で fetch/push のみに供給
  (helper リストは先にリセット: `credential.helper=` / `core.askpass=`)。
  全コマンド argv 配列 + spawnSync。シェル文字列禁止。

## 5.3 harness — コード化 spine + LLM on rails

`harness/`(独立 npm パッケージ。`@anthropic-ai/claude-agent-sdk@0.3.205`、zod v4、tsx)。
核心設計: 「LLM は提案し、小さなコード化 spine が処分する」。決定性は手書き TS から、
LLM は葉(leaf)のみ。

### spine(`harness/src/spine/`)— M2 チャット CLI(`npm run chat`)
- **actions.ts** — 効果境界の全部。アクションごとに zod raw shape(plain object。
  SDK `tool()` の要求で `z.object()` ではない)。`SpineAction` union:
  `run_worker{repo,instruction}`、`run_tests{repo}`、`review_diff{repo}`、`plan_repo{repo}`、
  `ask_human{question}`、`show_human{content}`、`request_publish{repo}`、`done{summary}`、
  `abort{reason}`。フィールド上限(REPO bare-name ≤200、INSTRUCTION ≤64KiB、QUESTION ≤4KiB、
  CONTENT ≤20KiB)。`ActionErrorCode`: `invalid_action, budget_exhausted, busy,
  invariants_not_met, repo_unknown, step_failed, publish_declined, publish_failed`。
- **session.ts** — streaming-input キュー上の長寿命 Agent SDK `query()` 1本。spine
  アクションは in-process MCP ツール(`mcp__spine__*`)として公開し、ハンドラが
  `executor.dispatch()` を呼ぶ。オプション: `cwd: workspaceRoot`(:ro で可)、
  `permissionMode: bypassPermissions` + `allowDangerouslySkipPermissions: true`、
  `settingSources: []`(対象リポジトリの CLAUDE.md をフロー制御判断に読み込まない)、
  `tools: READ_ONLY_TOOLS` + `disallowedTools: DENY_MUTATION`(ビルトインツールを
  Read/Grep/Glob に制限。MCP spine ツールはブロックしない)、
  `includePartialMessages: true`、`env: telemetryEnv(ticket,"spine")`。システムコンテキストは
  最初の user ターンとして注入(systemPrompt 上書きではない)。
- **executor.ts** — 処分側。直列(`busy` → `busy` 結果)。コード化パイプラインと**同じ
  プリミティブ**(exec.ts / gitops.ts / steps.ts / publish.ts)を再利用 — LLM は順序を
  決められるだけで、能力を広げられない。全アクションは**先に**総アクション予算を消費
  (ゴミ入力も予算を燃やす)。`run_worker` → `execImplement`(コミットメッセージ
  `mrw: WORKER <repo> run <n>`)。worker 実行を記録(HEAD が動けば verdicts 無効化)。
  `request_publish` → 先に `ledger.canPublish` ゲート → diff 再導出(complete-or-fail-closed)
  → `showForApproval` → `diffTouchesTests` なら追加 ack → 最終 `askHuman` publish 確認 →
  `publish()`。dispatch のたびに ledger 永続化。
- **ledger.ts** — per-repo 不変条件 ledger + 予算。`MRW_SPINE_MAX_ACTIONS`(既定100)、
  `MRW_SPINE_MAX_WORKER_RUNS`(既定12)、NaN 防御。`RepoLedgerEntry`:
  `{repoDir, baseSha, headSha, plan, testGreen:{sha}|null, reviewApproved:{sha,review}|null,
  published}`。`recordWorkerRun` は HEAD 移動時に testGreen + reviewApproved を無効化。
  `canPublish`: plan + `testGreen.sha===headSha` + `reviewApproved.sha===headSha` を要求
  (欠落/陳腐を名指しで返す)。atomic 永続化(temp+rename)→ `<dir>/spine-ledger.json`。
- **repl.ts** — 唯一の stdin/readline 所有者。チャットプロンプトと `ask_human` ゲートを
  1本の promise-chain ロックで直列化。EOF は decline(fail-closed で "" を解決)。
  stream_event デルタから assistant テキストをライブ描画。
- **index.ts** — リポジトリごとに setup-worktree(分割モードでは RPC)→ ledger 初期化 →
  executor → session → REPL を配線。ledger の置き場所 = `stateDir()`(分割モードでは
  `MRW_STATE_DIR/<ticket>`)。

### workerd typed RPC デーモン(`harness/src/workerd/`)— `npm run workerd`
- **protocol.ts** — ワイヤ契約。`MAX_REQUEST_BYTES=1MiB`。`WorkerRequestSchema` = `op` の
  discriminated union(`.strict()`): `setup_worktree{ticket,branch,purpose,repo:RepoConfig}`、
  `run_implement{ticket,repo,prompt≤512KiB,commitMessage}`、`run_fix{…}`、
  `run_tests{ticket,repo}`。識別子は BARE_NAME で、パスはデーモンが自前解決。prompt は
  orchestrator が作文するが、**ツール姿勢はデーモンがピン**する。`WorkerErrorCode`:
  `invalid_request, busy, worktree_invalid, setup_failed, step_failed, commit_failed,
  tests_failed_to_run, timeout, internal`。
- **handlers.ts** — `resolveContainedTarget` が `tasks/<ticket>/repositories/<repo>` を
  再導出し `<root>/tasks` 配下に留まることを assert(schema が escape を禁じていても
  多層防御)。`run_implement`/`run_fix` → `runAgentQuery(prompt,
  {...editSessionOptions(repoDir,kind), env: telemetryEnv(req.ticket,"worker"),
  abortController})` → **決定的 `commitAll(repoDir, commitMessage)`**(`mrw:` コミット、
  identity `mrw-worker@local`)。`run_tests` → `testGate(repoDir, WORKERD_TEST_TIMEOUT_MS)`
  (既定15分。spawn 失敗/タイムアウトは pass:false/status:null に折り畳み — 悪い exit は
  fix ループへの情報でありデーモン障害ではない)。
- **server.ts** — broker server のほぼ逐語クローン(F5): 直列 `busy`、1接続1 dispatch、
  タイムアウト分離、op ごとの `WORKERD_STEP_TIMEOUT_MS`(既定45分)AbortController が実行中
  SDK ステップをキャンセルし `timeout` 応答。クライアント切断で abort。socket `chmod 0666`。
- **client.ts** — orchestrator 側。送信前に schema 検証。`CLIENT_TIMEOUT_MS = STEP_BUDGET +
  5分`(デーモン自身の予算より必ず長く)。`rpcSetupWorktree/rpcRunImplement/rpcRunFix/
  rpcRunTests`、`ok:false` で throw。
- **index.ts** — 起動時クレデンシャル fail-closed チェック。broker socket なし・push なし。

### orchestrator / driver / steps のフロー
- **orchestrator.ts** — `runOrchestrator({instruction, repoDir, ...})` は再利用可能で typed
  `OrchestratorResult`(`published|declined|not_ready|failed`)を返す。`process.exit` 禁止。
  ループ: PLAN →(ready?)→ 人間 plan 承認 → IMPLEMENT → [REVIEW(read-only)+
  TEST-GATE]、有界 fix ループ(`MAX_FIX_ATTEMPTS` 既定3、fail-closed)→ publish 承認
  (diff 表示 + テスト独立性 caveat)→ broker 経由 publish。diff は **read-only な
  コミット範囲 `baseSha..HEAD`**(:ro で動く)。不完全 diff = ハード停止(reviewer
  盲目化ベクトル)。ゲートは委譲可能(driver がクロスリポジトリの結合ビューに束ねる)が、
  ゲートの**ロジック**は不変 — 変わるのは人間に聞く**場所**だけ。
- **exec.ts** — `WORKERD_SOCKET` 設定時 ⇒ worker デーモンへ RPC(パスから
  `tasks/<ticket>/repositories/<repo>` 形を要求して `{ticket,repo}` を導出)。未設定 ⇒
  **同じプリミティブ**を in-process 実行。トポロジに関わらず diff セマンティクスは1つ。
- **steps.ts** — `runPlan`/`runReview`(read-only 葉、常に in-process)、
  `buildImplementPrompt`/`buildFixPrompt`、`editSessionOptions(repoDir,kind)`(編集ツール
  姿勢の単一情報源: `tools: EDIT_TOOLS`、`disallowedTools: DENY_ALWAYS`、`maxTurns:80`)。
  read-only 葉は `READ_ONLY_TOOLS` + `DENY_MUTATION` + `settingSources: []` + `maxTurns:40`。
- **multi/driver.ts**(`npm run drive`)— 1チケット×Nリポジトリ。per-repo
  `runOrchestrator` + クロスリポジトリ結合 plan/publish ゲート。`phase3-state.json` で
  resume(published = チェックポイント、再実行時スキップ)。正直さ: クロスリポジトリの
  原子性は不可能 — 停止して完全な台帳を印字、無音の部分成功なし。
  `resolveResumedInstruction`: まだ何も publish していない場合のみ新しい指示を採用。
- **gates.ts** — `testGate`: `TEST_COMMAND` を spawnSync、**status===0 のみ**で分岐
  (null status = killed/timeout = fail)。モデルは合否を決めない。`humanApproval`:
  readline y/N、**EOF は decline**。
- **`diffTouchesTests(diff)`**(steps.ts)— `diff --git` ヘッダパスのヒューリスティック:
  `__tests__/`、`.test.`、`.spec.`、`_test.`、`tests?/`、`.e2e.`、`e2e/`、vitest/jest/
  mocharc/playwright 設定、`conftest.py`、package.json の `"test"` スクリプト行の増減。
  true なら publish ゲートで追加の明示 ack(green ゲートが coder の編集から独立でない
  可能性)。既知ギャップ: ルート直下の裸の `test.js` を見逃す([09](09-known-issues.md))。

### publish フロー(orchestrator 側、publish.ts)
- ケージ内で走る。トークン・push・git 書込を一切持たない。`BROKER_SOCKET` 未設定 ⇒
  Phase-1 スタブ(push なし)。設定時 ⇒ `buildRequest`(PR body は typed plan/review から
  構築。**diff やモデルの散文からは作らない**)→ unix socket で `sendToBroker`。
  `CONNECT_TIMEOUT_MS=35分`(broker の30分承認予算より大)。非 ok 応答は throw →
  fail-closed。broker の人間ゲートが権威。

### triage leaf(triage.ts / triage-cli.ts、`npm run triage`)
- ホスト側・ケージ外(ワークスペースが存在する前に `mrw task-up` が呼ぶ)。**プロンプト
  テキストのみ**から分類(cwd なし、リポジトリなし)。姿勢: `tools: READ_ONLY_TOOLS`、
  `disallowedTools: DENY_MUTATION`、`settingSources: []`、`maxTurns:8`。typed
  `Triage{work_type,title,repos,summary}` を返し、`filterToAvailableRepos` が subset 制約を
  **コードで**強制(zod では書けない)。CLI は検証済み JSON のみを stdout に(ログは stderr)。
- **既知の重大課題**: この posture はケージ外では不十分(Read が絶対パスを取れる)。
  再構築時は reviewer の posture(`tools: []` + Read/Grep/Glob も deny)を踏襲すべき。
  → [09-known-issues.md](09-known-issues.md) B 系統。

### telemetry 自己合成(telemetry.ts)
- **依存ゼロ**(node builtins のみ — steps.ts から循環なしで import 可。broker/reviewer は
  harness を import できないので精神を再実装: `broker/src/config.ts` の
  `ticketFromWorktreesRoot()`、`reviewer/src/sdk.ts` の `reviewerTelemetryEnv()`。
  3パッケージ独立、共有 import なし)。
- 伝播は「ワイヤ文字列の転送」ではない — 各セッションが信頼済みの値から**自分の**
  `OTEL_RESOURCE_ATTRIBUTES` を合成する。
- `telemetryEnv(ticket, role)` → `{...process.env, OTEL_RESOURCE_ATTRIBUTES:
  "workspace=<ticket|unlabeled>,work_type=<MRW_WORK_TYPE|feature>,role=<role>"}`。
  `SAFE_ATTR_VALUE = /^[A-Za-z0-9._-]{1,100}$/` — 不正値は `unlabeled` に**拒否**
  (無音の改変はしない。カンマ/等号/空白は k=v 構文を壊す)。`role` はコード供給リテラル
  (`worker|plan|review|spine|reviewer`)。`work_type` は operator の `MRW_WORK_TYPE` のみで
  上書き可、リクエストスコープでは不可。
- `ticketFromRepoDir(repoDir)` は最後の `tasks/<ticket>/repositories/<repo>` 出現から導出
  (不一致は null — telemetry がステップを失敗させてはならない)。**fail-open**:
  collector 不在なら OTLP export は無音でノーオペ。

## 5.4 egress 制御

- 仕組み(`docker/egress/squid.conf`): 明示 forward proxy(`http_port 3128`)。
  **平文 CONNECT ホスト**に対するドメイン allowlist — TLS 終端なし、SSL-bump なし、
  ケージに CA なし(CONNECT 行にホストが載るので TLS1.3 ECH は無関係)。CONNECT は 443 のみ、
  非 CONNECT も 443 のみ。`acl allowed_domains dstdomain "/etc/squid/allowlist.txt"`
  (先頭ドットはサブドメインに一致)→ allow → **`http_access deny all`**(拒否 CONNECT は
  403 → curl 非ゼロ。selfcheck が依存)。キャッシュなし。`entrypoint.sh` は先に
  `squid -k parse`(壊れた allowlist は大声で失敗。無音で開かない)。
- allowlist(`docker/egress/allowlist.txt`): `api.anthropic.com`(推論)+
  `registry.npmjs.org`(npm ci / テストゲート)。**意図的に除外**(理由つき):
  `sentry.io`(マルチテナント exfil シンク — 決して追加しない)、`statsig.anthropic.com`、
  `.github.com`/`.githubusercontent.com`(allowlist は fetch と push を区別できない —
  github を許すと push がネットワーク到達可能になる)、pypi。
- 強制方法: ケージは `caged`(internal: true)で外への経路なし。proxy 環境変数
  `HTTP(S)_PROXY=http://egress-proxy:3128` は利便性、`NO_PROXY=localhost,127.0.0.1,::1,
  egress-proxy,otel-collector`(OTLP は telemetry 網を直接通す。Squid に CONNECT 拒否
  させない)。**セキュリティはトポロジ**(fail-closed)であり、proxy 遵守は利便性。
- **WebSearch の注意**: WebSearch は allowlist 済み api.anthropic.com 経由の**サーバサイド**
  実行なので、ネットワークでは殺せない。アプリ層の `DENY_MUTATION`/`DENY_ALWAYS` deny が
  唯一の制御(Phase 4 L7 強化まで load-bearing)。
- selfcheck(`scripts/egress-selfcheck.sh`、ケージ内から): (1) 非 allowlist
  `example.com` がブロックされる (2) `api.anthropic.com` に proxy 経由で到達できる
  (3) `--noproxy '*'` の直接経路がない (4) DNS-exfil ガード(警告) (5) Docker socket が
  ない (6) **coder に push クレデンシャルがない**(GITHUB_TOKEN 等5種 + credential.helper)。
  違反があれば非ゼロ exit。
- role selfcheck(`scripts/egress-selfcheck-role.sh`、`ROLE=worker|orchestrator`):
  base チェック + ロールのマウント/ソケット境界。**worker**: `tasks/` 書込可、
  `repositories/` + `harness/` 書込不可、`/run/broker/publish.sock` なし、`BROKER_SOCKET`
  未設定、`/run/worker` あり。**orchestrator**: `$WS` 全体と `$WS/tasks` 書込不可
  (:ro 境界)、broker + worker 両ソケットあり、`MRW_STATE_DIR` 書込可。
  `postCreate.sh` が `ROLE=orchestrator` で実行。

## 5.5 認証・クレデンシャル

- **Anthropic OAuth(Keychain)**: `devcontainer-up.sh` が macOS Keychain
  (`security find-generic-password -s claude-code-oauth-token -w`)を読んで
  `CLAUDE_CODE_OAUTH_TOKEN` をプロセス env に注入(既設定の env が優先)。初回発行:
  `claude setup-token`(1年 OAuth)→ `security add-generic-password`。compose は
  **null-value passthrough**(`CLAUDE_CODE_OAUTH_TOKEN:` デフォルトなし)— 未設定ホスト
  変数は**完全に省略**される(空文字が他方のクレデンシャルを影で潰さない)。`.env`
  ファイルは意図的に廃止。OAuth(Pro/Max)か `ANTHROPIC_API_KEY`(従量)のちょうど
  一方を設定。`cli/mrw.mjs` もホスト側 triage 用に同じフォールバック。全 SDK
  エントリポイントは起動時にどちらも無ければ fail-closed。
  **`docker compose up` を直接叩くと(Keychain export なしで)reviewer が死ぬ —
  必ず `scripts/devcontainer-up.sh` 経由。**
- **broker PAT**: `BROKER_GITHUB_TOKEN=ghs_…` を `docker compose up` 前にホストシェルで
  export。broker コンテナ env のみに補間。`.devcontainer/.env` には**置かない**(それは
  coder の env_file — トークンがケージに漏れる)。broker に env_file が無いのはこのため。
  短命・リポジトリスコープ。read 側 git からは剥離、fetch/push/gh のみに付与。
- **焼き込み vs ランタイムバインド**:
  - イメージ焼き込み(ビルド = 信頼された瞬間): broker src + deps(書込剥奪)、
    reviewer src + deps(同)、egress allowlist + squid.conf(root 所有 RO)。
    ソースを焼くのは、ホストの `../broker/src` が coder 書込可能ツリー内にあるから —
    :ro マウントでも「改竄→次回再起動で実行」の供給経路が残る。
    **変更時は `docker compose build broker reviewer` が必要。**
  - ランタイム `:ro` バインド: `broker-policy.json`(de-bake。編集に再ビルド不要。
    それでも broker 所有・coder ツリー外で F2 検査)、orchestrator/broker への
    ワークスペース全体 :ro、worker への repositories/harness/scripts :ro。
  - ランタイム rw: worker の `tasks/`、orchestrator の `spine-notes`、broker の
    `review-diffs`。

## 5.6 エントリポイント・コマンド

- harness npm scripts(ケージ内 `/home/node/harness-run` から): `npm run chat`(spine
  REPL)、`npm run orchestrate`(単一リポジトリ)、`npm run drive`(マルチ)、
  `npm run workerd`(RPC デーモン)、`npm run triage`(ホスト側)、`npm run typecheck`、
  `npm test`(`node --import tsx --test test/*.test.ts`)。
- broker/reviewer: `npm start` = `tsx src/index.ts`。
- 起動: `scripts/devcontainer-up.sh [--build]` — Keychain トークン注入、
  `state_root()`/`config_dir()` から `MRW_STATE_ROOT`/`MRW_CONFIG_DIR` を設定、
  `mrw-telemetry` 網を冪等作成、`docker compose -f .devcontainer/docker-compose.yml up -d`。
- devcontainer.json: `orchestrator` にアタッチ、`runServices: [orchestrator, worker,
  broker, egress-proxy]`、`postCreateCommand: bash .devcontainer/postCreate.sh`、
  `remoteUser: node`、`overrideCommand: false`、`shutdownAction: stopCompose`、
  `forwardPorts: []`。
- 運用注意: 人間承認ゲートは **broker コンテナの stdin**(`docker compose attach broker`)。
  対話的 spine/chat は **orchestrator**。worker はヘッドレス(日常的にアタッチしない)。

## 5.7 テストカバレッジ(harness 81 + reviewer 8)

| スイート | 検証対象 |
|---|---|
| actions.test.ts(19) | アクション引数 schema: bare-repo 受理、slash/`..`/空/超過(>200)/文字種外の拒否、instruction 境界(64KiB ちょうど含む)、question/content/summary/reason の境界 |
| ledger.test.ts(~15) | canPublish の全ブロックパターン(テスト前/レビュー無/green 無/HEAD 移動で陳腐)、承認は現 HEAD 証明時のみ、request_changes は承認を記録しない、テスト失敗が green を消す、無変更 worker 実行は verdicts 保持、両予算の独立 fail-closed、atomic 永続化 |
| workerd-protocol.test.ts(~10×4 ops) | 有効リクエスト受理、bad ticket/repo/`..` 拒否、512KiB 超過/ちょうど、未知 op、`.strict()` の余剰フィールド拒否、応答フレーミング(改行ちょうど1つ) |
| telemetry.test.ts(12) | ticketFromRepoDir の受理/拒否、属性合成の正確性、unlabeled/feature フォールバック、MRW_WORK_TYPE 上書き、process.env 保存 |
| triage.test.ts(13) | TriageSchema 受理/拒否(work_type enum、title 境界、非配列 repos、全 WORK_TYPES)、filterToAvailableRepos(available のみ・重複除去・順序維持) |
| gitops.test.ts(4) | commitAll(clean = 無コミット、dirty = コミット + HEAD 移動 + mrw-worker identity)、commitRangeDiff(complete + ファイル名含有、偽 base sha ⇒ complete:false) |
| driver-resume.test.ts(6) | resolveResumedInstruction(未 publish なら採用、published あれば保持ほか) |
| reviewer/test/types.test.ts(8) | リクエスト schema(ticket 任意、diffPath/diffInline の排他、カンマ/スラッシュ/100字超 ticket 拒否、`.strict()`) |

## 5.8 設計根拠(コード内に明記されているもの)

- **worker が broker socket を持たない**: `/run/broker/publish.sock` が無く
  `BROKER_SOCKET` 未設定なら、publish を**依頼すら**できない。role-selfcheck が assert。
- **orchestrator のワークスペース全体 :ro**: 注入された orchestrator LLM にコード・spine
  ソース・broker ポリシーを変える経路がない。rw の ledger は worker 書込可能な tasks/
  ツリーから外れた別 volume。
- **worker への harness ソース :ro**: デーモンは自分のツール姿勢を定義するコードを
  書き換えられない。
- **broker/reviewer ソースの焼き込み**: ホスト側 src が coder 書込可能ツリー内にあるため。
  ポリシーだけは例外(不活性データなので RO バインド)だが coder 書込可能パスからは
  決して読まない。
- **reviewer にワークスペース・gh/git・トークンなし**: broker 描画の diff ファイル
  (or インライン)+ UNTRUSTED ラベル付き coder title/body を読み `{verdict,notes}` を
  返すだけ。何を言っても publish を強制/阻止できない。
- **ground-truth 描画**: broker は coder 供給の diff を決して信用しない(reviewer 盲目化・
  insteadOf/http.proxy リダイレクト・coder config 実行を無効化)。
- **NET_ADMIN ゼロ / トポロジで fail-closed**: ワークロード内ファイアウォールなし
  (自己エスカレーション対象がない)。ケージに外部 DNS なし(DNS トンネル exfil を閉塞)。
- **`bypassPermissions` は利便性であり封じ込めではない**: 実境界はコンテナ netns +
  `tools`/`disallowedTools`(bypass 下でも deny は勝つ。`allowedTools` は自動承認する
  だけでツールを除去しない — SDK #115)。
- **決定的 `mrw:` コミット**: implement/fix ごとに worker がコミットするので、diff は
  git オブジェクトの純粋読取(`baseSha..HEAD`、:ro で動く)になり、worktree は broker の
  `dirty_worktree` チェックに対して常にクリーン。トポロジに依らず diff セマンティクスは1つ。
