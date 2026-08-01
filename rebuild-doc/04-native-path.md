# 04 — ネイティブ macOS / cmux 経路 実装仕様

> 対象: `.claude/skills/` + `scripts/` + `templates/` + `.githooks/` で構成される、
> macOS サンドボックスと cmux を使った per-ticket マルチエージェント実行経路。
> ここに書かれた内容だけで、この経路をゼロから再実装できることを目標とする。

## 4.0 レイヤモデル

4つの信頼レイヤ。各レイヤは独立した Claude Code セッションであり、それぞれ専用の
`.claude/settings.json` を持つ。

| レイヤ | CWD | 役割 | サンドボックス |
|---|---|---|---|
| Root(管理コンソール) | ワークスペースルート `./` | 管理スキル9種の実行 | sandboxed(curated allow/ask/deny) |
| Origins | `repositories/<repo>/` | read-only クローン。worktree の供給元 | 編集禁止(設定は OTEL 属性のみ) |
| Worker | `tasks/<T>/agents/worker/` | 1チケットのサンドボックス実行者 | フル OS サンドボックス。network なし・push 不可 |
| Orchestrator | `tasks/<T>/agents/orchestrator/` | 1チケットの指揮者 | sandboxed + 特権スクリプト5本のみ `excludedCommands` |

パス解決の基本変数(`scripts/lib/common.sh` が提供):

- **tool_home / `workspace_root()`** = `scripts/` の親(ツールのチェックアウト)。
  `scripts/` `templates/` `.githooks/` `.claude/` `harness/` `docker/` `.devcontainer/` は常にここ。
- **`config_dir()`** = 有効な config ディレクトリ(`workspace.json` `repos.json` `purposes/`
  `broker-policy.json` を保持)。解決優先順位は3実装(common.sh / pre-push / mrw.mjs)で一致必須:
  1. `$MRW_CONFIG_DIR`
  2. `$PWD` から上位へ辿って最初に見つかる `workspace.json` を含む `.mrw/`
     (ただし **`tasks/` パスセグメント配下の `.mrw/` はスキップ** — セキュリティ必須)
  3. `<tool_home>/config`(レガシー既定)
- **`state_root()`** = `repositories/` と `tasks/` の置き場所。`workspace.json.state_root`
  (絶対パス必須)、空なら config_base(workspace モードでは `.mrw/` の親、それ以外は tool_home)。
- **`config_mode()`** = `"workspace"` | `"legacy"`。

## 4.1 管理スキル(9種)

すべて root コンソールから実行する `scripts/*.sh` の薄いラッパー。

### /setup-workspace → `scripts/setup-workspace.sh`
- 目的: ワークスペースの初期化・再同期。冪等。フラグ: `--skip-clone` `--dry-run`。
- 手順:
  1. `repos.json` の各エントリを `repositories/<name>` にクローンし、各リポジトリに
     `git config extensions.worktreeConfig true`(per-worktree sparse-checkout に必須)。
     URL に `your-org` を含むエントリはプレースホルダとしてスキップ。
  2. `templates/root/claude-settings.json` → `.claude/settings.json`、
     `templates/root/repositories-settings.json` → `repositories/.claude/settings.json` をレンダリング。
  3. pre-push フックの導入: `.githooks/pre-push` を chmod +x、`.gitconfig-workspace` に
     `core.hooksPath`(絶対パス)を書き、`~/.gitconfig` に `includeIf.gitdir:<scope>/.path` を
     **WORKSPACE_ROOT と STATE_ROOT の両スコープ**で登録。
  4. `scripts/cmux/cmux-wait.sh` → `~/.cmux-wait.sh`、`cmux-state.sh` → `~/.cmux-state.sh`(chmod +x)。
- 安全規則: `allowed_push_orgs` 空なら警告。`gh`/`cmux` 欠落で警告。セットアップ後は
  `claude` の再起動と **trust ダイアログの承認**が必要(untrusted だと `permissions.allow` が
  無視されサンドボックスが不完全になる)ことをユーザーに伝える。

### /open-task → `scripts/create-workspace.sh`(3フェーズ)
- 目的: メインエントリポイント。`tasks/<TICKET>/` を worktree + 両エージェント + cmux 3タブ付きで生成。
- 入力: チケットID(`ticket_id_pattern` に一致必須。プレフィクスは自動付与しない)、
  purpose(`config/purposes/*.json` から)、任意の `dev_kind`、対象リポジトリ、タイトル、チケットURL。
- 手順: (1) `ticket_source` アダプタでチケット取得 → (2) purpose/kind 選択 →
  (3) リポジトリ確認 → (4) `--phase init` → (5) スキル自身が `docs/task.md`(自己完結の
  チケット本文)を書き、`git -C` 直接実行で worktree 作成 → (6) `--phase finalize
  --skip-worktrees` → (6.5) `~/.claude.json` に両エージェントディレクトリの trust を jq で設定 →
  (7) `--phase cmux` → (8) 報告。
- 安全規則: worktree コマンドは `git -C repositories/<repo>`(`cd` 禁止)、ターゲットは
  **相対パス** `../../tasks/<T>/repositories/<repo>`、1回の Bash 呼び出しに1コマンド
  (`&&`/`;` 連結禁止)。trust はエージェント起動前に設定。プロジェクトの初期セットアップ
  (依存インストール・docker)は人間の仕事(Terminal タブ)。

### /list-task → `scripts/list-task.sh`
- `tasks/*/` を1行ずつ: チケット、purpose(`.task-meta.json`、フォールバックは OTEL 属性の
  スクレイプ)、最新 worker handoff の status、リポジトリ一覧。`.workspace-meta.json` が残って
  いれば `[SETUP INCOMPLETE]` 表示。`complete` のタスクは close 候補として提示。

### /close-task → `scripts/remove-workspace.sh`
- 未 push の作業(未コミット変更 or ローカルのみ/ahead のコミット)があれば `--force` なしでは拒否。
  cmux ワークスペースを先に閉じ、worktree を除去し、`tasks/<T>` を削除。
  ローカルの `feat/<T>` ブランチは**残す**。

### /add-repository
- タスクの orchestrator が持つのと**同じ特権スクリプト**
  (`agents/orchestrator/.claude/skills/add-repository-to-worker/scripts/add-repository.sh`)を呼ぶ。
  タスクブランチで worktree を作成(knowledge リポジトリは sparse)、新 origin の
  リダイレクト面(`.git/config`・`.git/hooks`・worktree の `config.worktree`)を worker サンドボックスの
  denyWrite にピン留めし、cmux で worker に通知。リポジトリは `repos.json` に存在しクローン済みが前提。

### /create-pr → `tasks/<T>/scripts/push-create-pr.sh`
- タスクブランチにコミットがある各リポジトリについて: porcelain クリーン確認 → PR 説明文を
  `docs/task.md` + 最新 `*_worker.md`(worker 起草の `pr_title`/`pr_body` を優先)+ リポジトリの
  `PULL_REQUEST_TEMPLATE.md` + diff stat から構築 → body を一時ファイルへ →
  `push-create-pr.sh <repo> --title ... --body-file <tmp>`(リポジトリごとに1呼び出し)。
  push 先は pre-push フックが強制。

### /gen-create-pr-command
- **人間**が Terminal タブ(Tab 2、`tasks/<T>/` に cd 済み)で実行する貼り付け用ワンライナーを
  生成。保留中の変更をコミット → タイトルと `docs/pr-body-<repo>.md` を起草 →
  `bash scripts/push-create-pr.sh <repo> --title ... --body-file docs/pr-body-<repo>.md`
  (タスクルート相対)を `pbcopy`。

### /start-task → `create-workspace.sh --phase cmux`
- 既存タスクの cmux タブを再オープン。先に `cmux workspace list` で重複を確認。
  `.worker-target` を新しい worker surface UUID に再ピン。`.workspace-meta.json` は不要
  (生成済みエージェントディレクトリだけが前提)。finalize 未実行なら明確に失敗。

### /update-task-sandbox → `scripts/update-task-sandbox.sh`
- worker のサンドボックスを広げる**唯一の**監査された経路(タスクは自身のサンドボックスを
  広げられない — `agents/**` は denyWrite)。アクション: `--show` `--add-domain` `--add-allow`
  `--add-ask` `--add-write <abs>` `--add-git-access`。push 権限はこの経路でも付与しない。
  反映には worker セッションの再起動が必要。Edit/Write の allow 追加(OS 書込境界が広がる)と
  `--add-git-access`(push が物理的に可能になり ask ルールのみで防御)には警告を出す。

## 4.2 タスクワークスペースの構造

`create-workspace.sh` が生成する `tasks/<T>/` のレイアウト:

```
tasks/<T>/
  .workspace-meta.json      # init フェーズで生成。cmux 成功の最後に削除(一時的)
  .task-meta.json           # finalize フェーズで生成。恒久的な真実の源
  CLAUDE.md                 # templates/default/CLAUDE.md(purpose で上書き可)
  docs/
    task.md                 # スキルが執筆(完全なチケット本文)or テンプレから雛形生成
    handoff/                # worker↔orchestrator の追記専用ログ
  repositories/<repo>/      # feat/<T> ブランチの git worktree
  scripts/
    push-create-pr.sh       # scripts/task/push-create-pr.sh のコピー、chmod +x
  agents/
    worker/
      .git                  # 空ファイル — 外側リポジトリからエージェントdirを隔離
      CLAUDE.md             # templates/task-worker/CLAUDE.md
      initial-prompt.md     # templates/{purposes/<p>|default}/initial-prompt.md
      .claude/settings.json # 生成(§4.3)
      .mcp.json             # purpose に mcp_servers がある場合のみ
    orchestrator/
      .git                  # 空ファイル
      CLAUDE.md             # templates/task-orchestrator/CLAUDE.md
      initial-prompt.md     # templates/task-orchestrator/initial-prompt.md
      .claude/settings.json # 生成(§4.3)
      .claude/skills/       # templates/task-orchestrator/skills/ からコピー
        .worker-target      # cmux フェーズで書き込み(ピン)。agents 配下で denyWrite
        send-cmux-command-to-worker/scripts/send-command.sh
        read-worker-output/scripts/read-output.sh
        wait-for-worker/scripts/wait-for-worker.sh
        add-repository-to-worker/scripts/add-repository.sh  # WORKSPACE_ROOT を焼き込み render
      .mcp.json             # worker のコピー(mcp_servers がある場合)
```

### テンプレート → 生成物マッピング

| 生成物 | テンプレート | 解決方法 |
|---|---|---|
| `docs/task.md` | `task.md` | `template_for`(purpose/kind 上書き)。既存なら生成しない |
| `tasks/<T>/CLAUDE.md` | `CLAUDE.md` | `template_for` 経由で `templates/default/CLAUDE.md` |
| `agents/worker/CLAUDE.md` | `templates/task-worker/CLAUDE.md` | 固定 |
| `agents/worker/initial-prompt.md` | `initial-prompt.md` | `template_for`(dev purpose は専用版あり) |
| `agents/worker/.claude/settings.json` | `templates/task-worker/claude-settings.json`(sandbox)/ `templates/default/claude-settings-no-sandbox.json`(no-sandbox) | `generate_agent_settings worker` + jq 後処理 |
| `agents/orchestrator/CLAUDE.md` | `templates/task-orchestrator/CLAUDE.md` | 固定 |
| `agents/orchestrator/initial-prompt.md` | `templates/task-orchestrator/initial-prompt.md` | 固定 |
| `agents/orchestrator/.claude/settings.json` | `templates/task-orchestrator/claude-settings.json`(no-sandbox 時は `.sandbox` を jq で削除) | `generate_agent_settings orchestrator` |
| ルート `.claude/settings.json` | `templates/root/claude-settings.json` | setup-workspace |
| `repositories/.claude/settings.json` | `templates/root/repositories-settings.json` | setup-workspace |

### テンプレート本文の必須指示

以下は生成後の振る舞いが依存する規範である。表現・章立て・補足説明は自由だが、各指示の
意味とリテラルパスは省略・弱化してはならない。

- `templates/task-worker/CLAUDE.md`: 起動時に `docs/task.md` を最初に読む。§4.4 の handoff
  書式・ファイル名・追記専用規則に従う。特権行為は `requests:` で依頼して idle し、exit
  しない。push/PR/パッケージ導入を自分で試みない。許可された worktree 内だけを編集し、
  implement/test/commit と結果報告を行う。
- `templates/task-orchestrator/CLAUDE.md`: `docs/task.md` と handoff を真実の源として扱い、
  ピン留め済み worker だけへ send/wait/read する。§4.3 の特権5スクリプトの生成後リテラル
  パスをすべて逐語掲載し、その経路以外でコード編集・push/PRを行わない。worker request を
  §4.4 の分岐で処理し、完了まで handoff result を追記する。
- `templates/{purposes/<p>|default}/initial-prompt.md`(worker): `docs/task.md` を読み、対象
  リポジトリを確認して作業を開始し、最初の handoff report を書いた後も idle で待機する。
- `templates/task-orchestrator/initial-prompt.md`: task/handoff を読み、worker に最初の指示を
  送り、background wait → 最新 report 読取 → request 処理のループを開始する。
- `templates/default/CLAUDE.md`(purpose 上書きを含む): タスクの目的・対象 repos・`docs/task.md`
  と `docs/handoff/` の位置を示し、生成物を手編集せずテンプレートから再生成する原則、
  worker/orchestrator/人間 Terminal の責務分離を明記する。

`templates/default/mcp.json` は MCP サーバ定義のカタログで、最上位がサーバ名をキー、値が
`{command:string,args?:string[],env?:object}` または `{type:"http",url:string,headers?:object}`
の JSON object とする。purpose の `mcp_servers` はこのキーだけを参照し、選択した定義を
Claude Code の `.mcp.json` の `{mcpServers:{...}}` にコピーする。

### タスクメタデータ schema

| ファイル | フィールド |
|---|---|
| `.workspace-meta.json` | `{ticket:string, purpose:string, repos:string[], branch:string, phase:"init", created_at:string}`。init 中だけ存在し、cmux 成功時に削除 |
| `.task-meta.json` | `{ticket:string, purpose:string, repos:string[], branch:string, title:string, ticket_url:string|null, created_at:string}`。finalize 後の恒久情報源 |

`list-task` は `.task-meta.json` が無い/不正なら、生成 settings の OTEL 属性をスクレイプして
purpose を復元し、復元不能なら `unknown` と表示する。`.workspace-meta.json` があれば、
復元結果にかかわらず `[SETUP INCOMPLETE]` を付ける。

### プレースホルダ置換

`common.sh` の `render_template()`。sed ベースの `{{NAME}}` → 環境変数値、区切りは `|`、
値は `sed_escape`(`& \ |` をエスケープ、改行はスペースに平坦化)を通す。認識される
プレースホルダは11個:

`{{WORKSPACE_ROOT}}` `{{STATE_ROOT}}` `{{CONFIG_DIR}}`(render 時に `config_dir()` の解決値)
`{{TASK_DIR}}` `{{TASK_DIR_H}}`(`to_home_path` による `~/` 形式)`{{TICKET_ID}}` `{{PURPOSE}}`
`{{TITLE}}` `{{TICKET_URL}}` `{{BRANCH}}` `{{REPOS_LIST}}`

置換後に `{{[A-Z_]+}}` が残っていれば警告。`TASK_DIR_H` は `excludedCommands` と Bash allow
ルールがバイト一致するために使い、sandbox のファイルシステムパスは素の `{{TASK_DIR}}` を使う。

`template_for <file> <purpose> [kind]` の優先順位:
`templates/purposes/<p>/kinds/<kind>/<file>` → `templates/purposes/<p>/<file>` → `templates/default/<file>`。

## 4.3 サンドボックスモデル

全設定は schema `https://json.schemastore.org/claude-code-settings.json`。

### Worker(sandboxed)
- `permissions.defaultMode: acceptEdits`、`allow: []`、`ask: []`。
- `permissions.deny`: Read で `~/.ssh/**` `~/.aws/**` `~/.config/gh/**` `~/.config/gcloud/**`
  `~/.npmrc`。Edit で `/{{TASK_DIR}}/agents/**` `/{{TASK_DIR}}/scripts/**`
  `/{{STATE_ROOT}}/repositories/**` `/{{WORKSPACE_ROOT}}/.claude/**` `/{{WORKSPACE_ROOT}}/scripts/**`
  `/{{WORKSPACE_ROOT}}/templates/**` `/{{WORKSPACE_ROOT}}/config/**` `{{CONFIG_DIR}}/**`
  `~/.claude.json`。
  `WebFetch`、`WebSearch` も deny。
- `additionalDirectories: ["{{TASK_DIR}}"]`。
- `sandbox`: `enabled:true`、`autoAllowBashIfSandboxed:true`、`allowUnsandboxedCommands:false`、
  **`excludedCommands:[]`(空を維持 — 不可侵)**。
  - `filesystem.allowWrite`: `{{TASK_DIR}}/repositories` と `{{TASK_DIR}}/docs` の2つのみ。
  - `filesystem.denyWrite`: `{{TASK_DIR}}/agents` `{{TASK_DIR}}/scripts`
    `{{WORKSPACE_ROOT}}/.githooks` `{{WORKSPACE_ROOT}}/.claude` `{{WORKSPACE_ROOT}}/config`
    `{{CONFIG_DIR}}/**`
    `{{WORKSPACE_ROOT}}/scripts` `{{WORKSPACE_ROOT}}/templates` `~/.claude.json`
    + **動的に注入される per-repo ピン**(下記)。
  - `filesystem.denyRead` + `credentials.files`(deny): 上記シークレット5パス。
  - `network.allowedDomains: []`(ネットワーク完全遮断)。

**動的 denyWrite ピン(C-2 リダイレクトベクトル対策)**: `generate_agent_settings` が
リポジトリごとに `<state_root>/repositories/<repo>/.git/config`、同 `.git/hooks`、および
worktree の `<gitdir>/config.worktree`(`worktree_gitdir` = `git rev-parse --absolute-git-dir`
で**解決**する。名前を推測しない)を denyWrite に注入する。worktree の `config.worktree` は
`core.hooksPath`/`remote.origin.url` を上書きできるため、汚染された worker が remote を
すり替えたりフックを無効化するのを防ぐ。**コミットに origin `.git` への allowWrite は不要**
(検証記録 S8-d、Claude Code ≥ 2.1.149)。finalize 時に worktree が見つからなければ設定生成は
**fail-closed**(`die`)— ピン無し worker を出荷しない。origin を `additionalDirectories` に
加えることは意図的にしない(共有クローンへ OS 書込境界が広がる — S2-o)。

### Orchestrator(sandboxed + 5つの脱出口)
- `permissions.allow`: 5本の Bash ルール。`{{TASK_DIR_H}}` 形式のリテラルパスで
  `send-command.sh` `read-output.sh` `wait-for-worker.sh` `add-repository.sh`
  `push-create-pr.sh`(それぞれ末尾 `*` 付き)。
- `permissions.deny`: worker と同じシークレット Read、加えて Edit で
  `/{{TASK_DIR}}/repositories/**` `agents/**` `scripts/**` `/{{STATE_ROOT}}/repositories/**`
  ワークスペースの scripts/templates/config/.claude、`{{CONFIG_DIR}}/**`、`~/.claude.json`、
  `WebFetch`、`WebSearch`。
- `additionalDirectories: ["{{TASK_DIR}}"]`。
- `sandbox.excludedCommands`: **10エントリ** — 5スクリプト各々の「素のパス」と「パス + ` *`
  (スペースグロブ)」の2形式。これにより引数の有無どちらでもサンドボックス外(ネットワーク有)で
  実行される。orchestrator が push でき worker ができない仕組みの本体。
- `filesystem.allowWrite`: `{{TASK_DIR}}/docs` のみ。`denyWrite`: `agents` `scripts`
  `repositories` + `{{CONFIG_DIR}}/**` + ワークスペースの `.githooks/.claude/config/scripts/templates`、
  `~/.claude.json`。
  `denyRead`: 追加で `{{TASK_DIR}}/agents` と `{{TASK_DIR}}/scripts`(orchestrator は worker や
  スキルの内部を覗けない。CLAUDE.md に「Operation not permitted は正常」と明記)。
  `network.allowedDomains: []`。

legacy モードでは `{{CONFIG_DIR}}` は `{{WORKSPACE_ROOT}}/config` に解決されるため、既存の
ピンと重複するだけで後方互換性は保たれる。

### Root(sandboxed コンソール)
- `env.OTEL_RESOURCE_ATTRIBUTES: workspace=ROOT`。
- `sandbox.network.allowedDomains`: `github.com` `api.github.com` `codeload.github.com`
  `registry.npmjs.org`。`deniedDomains`: `uploads.github.com`。
- `permissions.allow`: read-only な Bash 動詞(ls cat find grep rg echo printf mkdir jq gh、
  git status/log/diff/branch、git worktree list)。`ask`: `git push *`、`rm *`。
  `deny`: シークレット Read、`Edit(/repositories/**)`、`Edit(/.claude/**)`、`Edit(~/.claude.json)`。
  `additionalDirectories: ["{{STATE_ROOT}}"]`。

### Repositories レイヤ
- `env.OTEL_RESOURCE_ATTRIBUTES: workspace=REPOSITORIES` のみ。権限ロジックなし
  (origins はそもそも編集しない)。

### No-sandbox worker(`templates/default/claude-settings-no-sandbox.json`)
- `--no-sandbox` でタスク作成した場合に使用。ツールレベルのガードのみ。明示的な
  `_security_note` を持つ: OS サンドボックス無しでは allow 済みシェルツールが deny 対象
  ファイルを読め、Bash リダイレクトが制御ファイル(`.githooks/pre-push`・`.git/config`・
  `push-create-pr.sh`)を上書きできる — push 境界とスクリプト完全性は**保証されない**。
  allow リストから `find -exec`/difftool 系の脱出口を意図的に除外。`find`/`git push`/`rm`/
  `curl`/`wget` は `ask`。no-sandbox orchestrator = 本物の orchestrator テンプレートから
  jq で `.sandbox` を削除したもの(5つの allow ルールは維持)。

### Pinned worker target(ピン留めされた worker ターゲット)
`agents/orchestrator/.claude/skills/.worker-target` は orchestrator セッション開始**前**に
`create-workspace.sh` の `phase_cmux` が書く:

```
WORKER_CMUX_WORKSPACE=<workspace-uuid>
WORKER_CMUX_SURFACE=<worker-surface-uuid>
```

`agents/**`(両エージェントとも denyWrite)配下にあるため、どちらのエージェントも改変不可。
orchestrator の4スクリプトはこのファイルを source し、**`--workspace`/`--surface` 引数を拒否**
する — orchestrator は自分の worker としか通信できない。surface は UUID で指定(フォーカスや
並び替えでピンが壊れない)。

### Orchestrator の push 特権(2段構え)
1. `push-create-pr.sh`(+ 4つのスキルスクリプト)が `sandbox.excludedCommands` に列挙され、
   サンドボックス外・ネットワーク有で実行される。マッチは**コマンド文字列のリテラル比較**
   (だから正確なリテラルパスが必須で、素+`*` の2形式が要る)。
2. `agents/**` のスクリプトと `tasks/<T>/scripts/**` は両エージェント denyWrite ⇒ どちらの
   エージェントも特権スクリプトを改変できない。

つまり公開(push/PR)は、worker が物理的に到達できず、双方が改竄できない、単一の監査された
経路である。

## 4.4 Handoff プロトコル

- 置き場所: `tasks/<T>/docs/handoff/`(両エージェントが書ける唯一の共有面 — 双方
  allowWrite は `docs` のみ)。
- ファイル名: `YYYYMMDD_HHmmss_NNN_<role>.md`、role ∈ `worker`|`orchestrator`。
  タイムスタンプは `date +%Y%m%d_%H%M%S`。`NNN` は3桁連番で、**送り手を問わず**ディレクトリ内の
  最大 `NNN` + 1。追記専用: 既存ファイルの変更・削除禁止。1メッセージ = 1ファイル。
- Worker ファイル(`type: report`): `status: in_progress | awaiting_next | blocked | complete
  | failed`、`task_ref`、`summary`、任意の `requests:` リスト
  (`id: req-<NNN>-M`、`action: push_and_pr | install_package | other`、`repo`、`branch`、
  worker 起草の `pr_title`/`pr_body`、`detail`)。書いたら worker は**ターンを終えるが exit
  しない**(idle = 次の指示待ちシグナル)。
- Orchestrator ファイル(`type: result`): `refs: <request id>`、`status: done | failed |
  deferred`、`summary`。
- ループ: orchestrator が指示送信 → `wait-for-worker` を待機(run_in_background)→ ターン終了 →
  `RESULT status=...` を受けて最新 `*_worker.md` を Read → 未解決 request を処理
  (`push_and_pr` → レビュー + push-create-pr / `install_package` → Terminal タブで人間に依頼 /
  `other` → 判断・エスカレーション)→ 自分の handoff を書く → `complete` まで繰り返し。

## 4.5 pre-push フック(`.githooks/pre-push`)の強制ロジック

`core.hooksPath` + `~/.gitconfig` の `includeIf` により、ワークスペース配下の全リポジトリ・
worktree に適用(worktree は origin の config を共有)。git は `$1`=remote 名、`$2`=remote URL
で起動する。

1. **config 発見の walk-up**(common.sh・mrw.mjs と一致必須。モードBでの機構選択は
   §4.10-1を参照): `$PWD`(git はフックを
   work tree を cwd に実行)から `/` まで上へ。各ディレクトリについて、**`*/tasks` または
   `*/tasks/*` にマッチするならスキップして上へ**(セキュリティ上の要: プロンプト注入された
   worker は自分の worktree に `.mrw/workspace.json` をコミットできる(porcelain チェックは
   通る)ため、allowlist を偽装できてしまう。正規のワークスペース `.mrw/` は `tasks/` の兄弟=
   上位にある)。そうでなければ `<d>/.mrw/workspace.json` が存在すれば採用。フォールバック:
   `<WORKSPACE_ROOT>/config/workspace.json`(`WORKSPACE_ROOT` = フックのあるディレクトリの親)。
2. **fail-open(警告 + `exit 0`)は config ファイル不在/`jq` 不在のときのみ** — 壊れた
   フックでユーザーを締め出さない。「不在」と「破損」は区別する。

   | 失敗クラス | pre-push | common.sh | mrw.mjs |
   |---|---|---|---|
   | config ファイル不在 | fail-open(警告 + exit 0) | 既定へフォールバック | 既定へフォールバック |
   | jq / パーサ不在 | fail-open(警告 + exit 0) | die | die 相当(throw) |
   | config パース不能(不正 JSON) | fail-closed(エラー + exit 1) | die | throw |
   | `state_root` / `config_dir` が相対パス、または正規化(realpath 等)が失敗 | fail-closed | die | throw |
   | 解決した `config_dir` が `tasks/` パスセグメント配下 | fail-closed(拒否して上位を探す。見つからなければ「不在」扱い) | 同左 | 同左 |
3. remote URL から host + org をパース。3形式: `scheme://[user@]host/org/...`、
   `git@host:org/repo`、`ssh://...`。org か host がパース不能 ⇒ **BLOCKED(exit 1)**。
4. **host allowlist を最初に・常に強制**(`allowed_push_orgs` が空でも)。
   `allowed_push_hosts`(既定 `["github.com"]`)に一致しない host ⇒ BLOCKED
   (`https://evil.example/ALLOWED_ORG/repo` 型の持ち出しを防ぐ)。
5. **org allowlist**: `allowed_push_orgs` が空 ⇒ 警告 + `exit 0`(host チェック通過後のみ)。
   非空なら org ∈ allowlist のときだけ exit 0、それ以外 BLOCKED。

`push-create-pr.sh` は push コマンドラインに `-c core.hooksPath=<WORKSPACE_ROOT>/.githooks` を
強制し、`--no-verify` を決して渡さない ⇒ worktree ごとの `config.worktree` 上書きでガードを
無効化できない。`<WORKSPACE_ROOT>/.githooks/pre-push` が実行可能でなければ **fail-closed**。

## 4.6 config スキーマ

### `config/workspace.json`
| フィールド | 意味 |
|---|---|
| `allowed_push_orgs`(配列) | push を許可する GitHub org/user。空 = 無制限(警告のみ) |
| `allowed_push_hosts`(配列、既定 `["github.com"]`) | push を許可する host。org と併せて必ずチェック |
| `default_purpose`(文字列) | 例 `"dev"` |
| `ticket_source`(文字列) | `scripts/lib/ticket-sources/` のアダプタ名(拡張子なし)。`manual` \| `github-issues` \| カスタム |
| `ticket_id_pattern`(正規表現、既定 `^[A-Z]+-[A-Za-z0-9_-]+$`) | プレフィクス必須。自動付与しない |
| `branch_prefix`(既定 `feat/`) | タスクブランチは `<branch_prefix><TICKET_ID>` |
| `state_root`(絶対パス or 空) | `repositories/`+`tasks/` の置き場所。空 ⇒ workspace base。設定時は絶対パス必須(でなければ die)。config 自体は常に config_dir |

### ticket-source アダプタ契約

| 項目 | 契約 |
|---|---|
| 配置 | `scripts/lib/ticket-sources/<ticket_source>.sh` |
| 関数 | `fetch_ticket <id-or-url>` |
| 成功 | exit 0。標準出力は余分な文字を含まない JSON object `{id,title,body,url}`(4値とも文字列) |
| 失敗 | 診断は標準エラー、非ゼロ exit。`open-task` / `mrw task-up` は停止せず手入力へフォールバック |

`manual` は取得を試みず手入力へ進む実装、`github-issues` は ID または GitHub issue URL を
受けて同じ JSON を返す実装とする。カスタムアダプタも同じ関数・I/O 契約だけで追加できる。

### `config/repos.json`
`.repositories[]`: `name`(`repositories/` 配下のディレクトリ名)、`url`(clone URL。
`your-org` を含めばプレースホルダとして setup がスキップ)、`desc`、
`type`: `"code"`(フルチェックアウト)| `"knowledge"`(sparse。worktree add 時 `--no-checkout`)、
任意 `sparse_paths`(purpose 名 → cone パス配列)。

### `config/purposes/*.json`(ディレクトリスキャンで発見)
`description`(選択肢表示用)、`default_repos`(open-task の初期リポジトリ集合)、
`mcp_servers`(`templates/default/mcp.json` のサーバ名。finalize で検証、未知名は警告+無視)、
`dev_kinds`(任意のサブ分類。`templates/purposes/<p>/kinds/<kind>/` でテンプレ上書き可)。

`config/broker-policy.json` は**コンテナ経路**の in-process org 強制(多層防御の対)。
ネイティブ経路は pre-push フックに依存する。

## 4.7 Worktree 作成規則

open-task の主経路は Claude が `git -C` を直接実行。`scripts/lib/effects/worktree.sh` の
`create_worktree()` はスクリプト版の等価物(規則は同一)。リポジトリ `<r>`、チケット `<T>`、
ブランチ `<branch>` = `<branch_prefix><T>`(既定 `feat/<T>`)について:

- **origin** = `<state_root>/repositories/<r>`。**ターゲットは相対パス必須**:
  `../../tasks/<T>/repositories/<r>`(不変条件: ワークスペースを移動しても worktree リンクが
  生きる。`repositories/` と `tasks/` は state_root 配下の兄弟なので `../../` が state_root 内で
  解決する)。常に `git -C <origin>`、`cd` 禁止、コマンド連結禁止。
- ブランチ選択:
  - ローカルブランチあり → `worktree add <target_rel> <branch>`
  - なければ `origin/<branch>` あり → `worktree add --track -b <branch> <target_rel> origin/<branch>`
  - どちらもなし → `worktree add -b <branch> <target_rel>`(HEAD から新ブランチ)
- **knowledge リポジトリ**: `--no-checkout` を付け、その後
  `git -C <target> sparse-checkout set --cone <sparse_paths[<purpose>]>` →
  `git -C <target> checkout <branch>`。`sparse_paths` に当該 purpose が無い、配列が空、または
  フィールド自体が無い場合は sparse-checkout を有効化せず、`git -C <target> checkout
  <branch>` で通常の全体 checkout にする。origin 側に
  `extensions.worktreeConfig true` が必要(setup が設定)。
- 冪等: ターゲットディレクトリが既にあればスキップ。`worktree_gitdir()` は git が割り当てた
  実際のプライベート gitdir を解決(名前衝突時は `<r>` と異なりうる — 解決する、推測しない)。
  `remove_worktrees()` は `worktree remove --force` → `rm -rf` → **その後** `worktree prune`
  (remove 失敗でも prune が stale 登録を消せる順序)。
- `worktree add` 自体はサンドボックス互換(書くのは `.git/worktrees/` のみ)。
  `git init`/`clone` は常にブロックされる。

## 4.8 cmux 統合

ヘルパは `scripts/lib/effects/cmux.sh`(すべて `CMUX_QUIET=1`、UUID を stdout、ログを stderr)。
`cmux_available()` = `command -v cmux` && `cmux ping` が `PONG`。

**タブ/ワークスペース作成**(`phase_cmux`)— `<T>` という名前のワークスペースに3タブ:

1. `cmux_new_workspace <T> <worker_dir> "<worker_cmd>"`(`--focus false`)。ワークスペース UUID は
   `cmux workspace list --id-format both` の**完全一致**タイトルで解決
   (`cmux_workspace_uuid_by_name`。選択マーカー・`[selected]`・グリフを剥がし、`ABC-1` ≠
   `ABC-12` を保証)。worker_cmd = `claude --permission-mode acceptEdits "$(cat initial-prompt.md)"`
   (`--cwd` = worker_dir。worker が自動起動する)。タブ名は **"Worker Claude"**。
2. `.worker-target` をピン(workspace + 最初の surface UUID を `cmux_first_surface_uuid` で) —
   orchestrator 起動**前**。
3. `cmux_new_tab <ws> "Terminal"`(`new-surface --type terminal`、UUID は
   `OK surface:N (UUID)...` からパース)→ `cmux_send_line` で `cd <TASK_DIR>`
   (パスは `%q` クオート。`new-surface` に `--cwd` がないので cd を明示)。
4. `cmux_new_tab <ws> "Orchestrator Claude"` →
   `cd <orch_dir> && claude "$(cat initial-prompt.md)"` を送信。

`cmux_send_line` = `cmux send` の後に**別コマンドで** `cmux send-key enter`(テキストだけでは
送信されない)。ガード: 同名 `<T>` のワークスペースが既に存在すれば2つ目を作らない(競合する
worker の起動・再ピンを防ぐ)。警告して `.workspace-meta.json` を削除して return。生きている
ワークスペースに `.worker-target` がなければ追加警告。teardown では close-workspace を
worktree 除去より**先に**実行。

**cmux-wait.sh**(`~/.cmux-wait.sh`): 引数 `<ws> <surface> [timeout=1800]`。
`~/.cmux-state.sh` を `POLL_INTERVAL`(5秒)ごとにポーリング。デバウンス: `IDLE_CONFIRMS`(2)回
連続 idle かつ(一度 running を観測済み or `GRACE`=20秒経過)で settled。`dead` は
`DEAD_CONFIRMS`(2)回連続が必要。出力:
`RESULT status=<idle|dead|timeout> surface=<uuid> elapsed=<s>` + `--- pane tail ---` + 直近40行。

**cmux-state.sh**(`~/.cmux-state.sh`): `<ws> <surface>` → `running|idle|dead`。
`read-screen` 失敗 = `dead`。画面末尾40行が
`RUNNING_PATTERN = 'esc to interrupt|ctrl\+b to run in background|Compacting conversation'` に
マッチ = `running`、それ以外 = `idle`。純粋な画面ヒューリスティック(セッション内フックなし)。

**クリップボードフォールバック**(cmux なし): `phase_cmux` が worker/orchestrator の手動起動
コマンドを表示し、worker メッセージングスキルは使えない旨を注記。`pbcopy` があれば worker
コマンド(`cd <worker_dir> && <worker_cmd>`)をコピー。

## 4.9 テストカバレッジ(`tests/run-tests.sh`)

依存ゼロの bash ランナー(common.sh を source)。検証項目:

- `to_home_path`: HOME 配下 → `~/…`、外は不変、HOME プレフィクスが境界でない場合は不変。
- `sed_escape`: `&`・`|`(区切り)・`\` のエスケープ。
- `render_template`: 特殊文字(`&`、`|`)を含む置換。未設定変数 → 空。
- `template_for`: default フォールバック、purpose 上書き、未知 kind → purpose フォールバック。
- `list_purposes`: `dev` と `task` を含む。
- `json_get`: 存在・null→default・欠落→default・`join`。
- チケットID パターン: 正常系、suffix 付き、プレフィクス欠落(NG)、小文字(NG)、パストラバーサル(NG)。
- `validate_ticket_id`(セキュリティ境界。サブシェルの exit code で): 正常受理。スラッシュ
  トラバーサル・`..`・空・小文字プレフィクス・**改行埋め込み**(旧 grep 行単位バイパス)を拒否。
- pre-push フック(実物をサブプロセスで一時 config に対して実行): 許可 org+host 通過
  (https と scp 形式 ssh)、禁止 org ブロック、org 一致でも禁止 host ブロック、パース不能 URL
  ブロック、org 空でも host は強制。
- `worktree_gitdir`(実 git フィクスチャ): `…/.git/worktrees/fixture-repo` を解決
  (suffix 一致 — macOS の `/var` vs `/private/var`)。ピンパス導出可能(非空)。
  欠落 worktree は非ゼロ。
- harness の `node:test` スイート(ガード付き): `harness/node_modules/.bin/tsx` が実際に変換を
  実行できる場合のみ `npm test`(`tsx -e 'process.exit(0)'` を試す — `--version` では不十分。
  macOS ホストに Linux コンテナの esbuild バイナリがある事故をガード)。

`FAIL == 0` のとき exit 0。

## 4.10 再実装時に維持すべき不変条件(この経路)

1. push ガード(broker in-process / pre-push)が参照するポリシーの解決は、worker が書込可能な
   いかなるパス(`tasks/` 配下・worktree 内コミットを含む)からも影響を受けてはならない。
   3実装が同一ポリシーを解決することを検証で保証する(機構は walk-up でも焼き込みでもよい)。
   モードBでは [09-known-issues.md](09-known-issues.md) の A 系統の是正方式(セットアップ時に
   config パスを焼き込み、pre-push はそれを優先して読み、walk-up はレガシー/未セットアップ時の
   フォールバックとする)を採用すること。この場合も本項が要求する成果(worker 書込可能パスからの
   影響を受けない)は維持される。
2. host allowlist は最初に・常に強制。org allowlist は空でもよい(警告)が host は迂回不可。
3. worktree ターゲットは常に相対 `../../tasks/<T>/repositories/<repo>`。`git -C` を使い、
   `cd` もコマンド連結もしない。
4. worker には origin `.git` への allowWrite を決して与えない(コミットは無くても動く)。
   代わりにリダイレクト面(`.git/config`・`.git/hooks`・worktree `config.worktree`)を
   denyWrite でピン留めする。denyWrite はあらゆる allow に勝つ(「今後確認しない」による
   settings.local.json のドリフトも含め)。
5. 唯一の監査された公開経路 = `push-create-pr.sh`。orchestrator の excludedCommands 経由でのみ
   到達可能、push に core.hooksPath を強制、両エージェントから書込不可。
6. `.worker-target` は orchestrator 起動前にピンされ、denyWrite の `agents/**` 配下にあり、
   UUID で参照され、スキルスクリプトはターゲット上書きを拒否する。
7. `excludedCommands` はコマンド文字列のリテラル一致(素 + `* ` の2形式)。生成パスは `~/`
   home 形式(`TASK_DIR_H`)を使い、呼び出し側は正確なリテラルパスを使う。
8. `.workspace-meta.json`(init、一時的、cmux 後削除)と `.task-meta.json`(finalize、恒久)を
   区別する。`start-task`/`--phase cmux` は前者を要求してはならない。
9. sandboxed worker で worktree ピンが解決できなければ設定生成は **fail-closed**。
10. タスクは自身のサンドボックスを広げられない。`update-task-sandbox.sh`(root コンソール)が
    唯一のエスカレーション経路で、push は決して付与しない。
