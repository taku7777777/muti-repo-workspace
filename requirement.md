# マルチリポ・ワークスペースの「GitHub リポジトリ化」 — 実装ハンドオフ資料

> このドキュメント単体で、別エージェントが「現行のスキル群で実現しているマルチリポ・ワークスペース構成を、1 つの GitHub リポジトリとして再実装する」タスクに着手できることを目的とする。
>
> - **現行実装の場所**: `copilot-marketplace/plugins/homehub-multi-repo-workspace-v2/`（本資料の全ての行番号・パスはここ基準）
> - **本資料の作成時点**: 2026-07-04 / ブランチ `feat/multi-repo-workspace-v2`
> - **反映済みの最新変更**: PR #170（merged）「2エージェント運用モデル + handoff 導入」— `docs/handoff/` 追記専用イベントログ、worker の idle-not-exit プロトコル、worker `permissions.ask=[]`、`wait-for-worker.sh` 命名統一（§3.8）。
> - **併記した将来設計（未実装・合意済み）**: worker を用途別に権限プロファイル化する **4 アーキタイプ（coder / reader / researcher / documenter）＋ マルチ worker 機構**（§10）。リポジトリ化のゴールに直結するため、現行実装と区別したうえで盛り込む。
> - 現行実装は「copilot-marketplace という marketplace リポジトリの中のプラグイン（スキル群）」であり、`npx skills add` で各ユーザのローカル `~/homehub` ワークスペースへ**インストールされて**動く。本タスクのゴールは、これを **`multi-repo-workspace` という単一の Git リポジトリそのもの**として成立させることである。

---

## 1. ゴールと背景

### 1.1 やりたいこと（ユーザの要望そのまま）

> homehub multi repo workspace で実現されているような構成を、**スキルではなく GitHub のリポジトリ**で実現したい。
>
> `multi-repo-workspace` というリポジトリがあり、その中の **`repositories/` 配下に適宜必要なリポジトリを git clone** しておいて、**`open-task` や orchestrator から worker を起動してタスクを進める**、というイメージ。

### 1.2 現行方式（スキル配布型）の要点と、リポジトリ化で変えたいこと

| 観点 | 現行（スキル配布型 / v2） | リポジトリ化後（ゴール） |
|---|---|---|
| 配布・導入 | `npx skills add <marketplace URL> --skill '*'` で `~/homehub/.claude/skills/` へインストール | `git clone <multi-repo-workspace>` して即使える。スキル/スクリプト/テンプレは**リポジトリにコミット済み** |
| ワークスペース本体 | `setup-workspace.sh` が `~/homehub` を**スキャフォールド**（scripts/ templates/ .claude/ を毎回コピー生成） | **リポジトリ自体がワークスペース**。scripts/ templates/ .claude/ は最初から存在しコミットされている |
| バージョン管理 | ワークスペース自体は git 管理外（生成物）。真実のソースは marketplace 側 | ワークスペース＝リポジトリなので、構成・テンプレの変更履歴がそのまま追える／PR でレビューできる |
| repositories/（対象リポ群） | `setup-workspace.sh` が `git@github.com:bitkey-service/...` を clone。`.gitignore` で workspace 生成物は無視 | 同様に `repositories/` 配下へ clone。ただし**親リポにネストした git repo をどう扱うか**（gitignore / submodule / 明示除外）を設計する（→ §7） |
| スキルの解決 | Claude Code が `~/.claude/skills` or `<ws>/.claude/skills` から解決。Base directory をスキル提示文で受け取る | リポジトリ内の相対パス（例 `.claude/skills/...`）で解決。`npx skills add` に依存しない形にできると理想 |

### 1.3 「変えない」コア価値（＝移植の必須要件）

リポジトリ化しても以下は**そのまま再現**する必要がある。これが本システムの本質。

1. **チケット単位の独立ワークスペース**を `tasks/<TICKET_ID>/` に作り、複数リポの **git worktree**（ブランチ `feat/<TICKET_ID>`）を展開する。
2. **orchestrator / worker の二役 + cmux 3 タブ**による協調実行（司令塔と実働の分離）。**worker は idle に戻り exit せず**、`docs/handoff/` 追記でステータス報告・越権依頼する（§3.8）。将来はこの worker を**用途別アーキタイプ化して複数並列**にする（§10）。
3. **多層 sandbox**（root / 管理コンソール / origins / per-task worker / per-task orchestrator）による OS レベルのセキュリティ境界（詳細は §2.1）。
4. **purpose × preset** の 2 軸でワークスペース構成（対象リポ・MCP・進め方ガイド）を決める。
5. **Notion（PBI）連携**でチケット情報を `docs/task.md` に転記し、worker が自律着手できる状態にする。

---

## 2. 現行アーキテクチャ全体像

### 2.1 レイヤ構造（5 面。各 OTEL ラベル付き）

セキュリティ境界を複数の面に分ける。各面は自分の `.claude/settings.json`（permission + sandbox）を持ち、OTEL `workspace=` ラベルでコスト可視化される。**「orchestrator」という語が 2 つの別レイヤを指す**ので注意（下表 B と E）。

| # | 面 | 場所 | OTEL | 生成主体 | 役割 | ネットワーク | 期待値の正 |
|---|---|---|---|---|---|---|---|
| A | **Root** | `<ROOT>/`（リポジトリ直下） | `ROOT` | setup-workspace | 人間の最上位。初期セットアップ・全体把握 | github.com / registry.npmjs.org（`deniedDomains: uploads.github.com`） | `root-settings-reference.md` |
| B | **管理コンソール（orchestrators/task-manager）** | `<ROOT>/orchestrators/task-manager/` | `ORCHESTRATOR` | setup-workspace | **永続の管理層**。ここで `claude` を起動し `/open-task` 等を実行 | github.com / api.github.com| `orchestrator-settings-reference.md` ＋ テンプレ `templates/task-manager/claude-settings.json` |
| C | **origins（repositories/）** | `<ROOT>/repositories/` | `REPOSITORIES` | setup-workspace | worktree 元・Read-only のソース保護境界 | （env の OTEL のみ） | — |
| D | **per-task Worker** | `tasks/<TICKET>/agents/worker/` | `<TICKET>,purpose=…` | open-task | 実働。sandbox 内で lint/build/test/commit を自律実行 | 全拒否（`allowedDomains:[]`）、localhost のみ | テンプレ `templates/task-worker/claude-settings.json`（`task-settings-reference.md` は agents 分割前モデルなので worker テンプレを正とする） |
| E | **per-task Orchestrator** | `tasks/<TICKET>/agents/orchestrator/` | worker と**同一**の `<TICKET>,purpose=…`（role 別ラベル無し＝コスト上 worker/orchestrator は分離不可） | open-task | **タスクの司令塔**。worker への指示・repo 追加・push/PR。自分ではコード編集しない | `allowedDomains:[]`（push/PR は `excludedCommands` 登録の `push-create-pr.sh` で sandbox 外実行するため in-sandbox network 不要） | テンプレ `templates/task-orchestrator/claude-settings.json` |

> **重要な用語整理（レビュー反映）**:
> - **B（`orchestrators/task-manager`）は「旧記述」ではなく現役**。`setup-workspace.sh` が今も生成し（`setup-workspace.sh:25,386,752-758`、OTEL=`ORCHESTRATOR`）、README:32 の `cd orchestrators/task-manager && claude` はこの層。`open-task` 等の管理スキルはここで走る。
> - **E（`agents/orchestrator`）は per-task の司令塔**（コミット `4506c30`「agents構成」）。cmux Tab 3 として worker（Tab 1）を制御する。
> - つまり「orchestrator」は **管理コンソール層（B）** と **タスク司令塔層（E）** の 2 つが共存する。移植では両方を再現する。B の期待値は `orchestrator-settings-reference.md`、E の期待値は `task-orchestrator/claude-settings.json` テンプレ（両者は excludedCommands・network・allowWrite が別物）。

### 2.2 ディレクトリ構成（リポジトリ化後の想定）

```
multi-repo-workspace/                 # ← これが Git リポジトリ本体（= 従来の ~/homehub）
├── CLAUDE.md                         # Root 層の指示
├── .claude/
│   └── settings.json                 # Root sandbox（OTEL workspace=ROOT）
├── .gitignore                        # repositories/ や tasks/ の扱いを定義（§7）
├── scripts/                          # ワークスペース管理スクリプト（コミット済み）
│   ├── setup-workspace.sh            # repositories/ の clone・初期化
│   ├── create-workspace.sh (open-task) # タスク作成本体（1800行超・2 phase）
│   ├── update-task-purpose.sh
│   ├── update-task-sandbox.sh
│   ├── add-repository.sh
│   └── remove-workspace.sh
├── skills/                           # orchestrator/worker が使うスキル群（§4）
│   ├── open-task/  … send-cmux-command-to-worker/ read-worker-output/
│   ├── wait-for-worker/  create-pr/  gen-create-pr-command/  等
├── orchestrators/
│   └── task-manager/                 # ★管理コンソール層（B）。ここで claude 起動→/open-task
│       ├── CLAUDE.md
│       ├── .claude/settings.json     # OTEL workspace=ORCHESTRATOR
│       └── scripts/settings/…        # ★テンプレ/参照の runtime 実体（$SETTINGS_DIR、§3.7）
│                                     # ↓ references/ の実体（§3.7 の三段構造）。templates/presets/mappings は「兄弟」
├── references/                       # 真実のソース（repo-time）
│   ├── templates/
│   │   ├── default/  root/  task-worker/  task-orchestrator/  task-manager/
│   │   └── additional/purposes/{dev,incident,task,project}/
│   │        # ※dev のみ中間層 additional/kind/{feature,bug,improvement,unknown}/ と default/, additional/repository/type-web/ の三系統
│   ├── presets/purposes/{dev,incident,task,project,alert}.json    # default_repos / default_mcp_servers
│   ├── mappings/{mcp-tools.json, repo-area-mapping.json}          # skills 付与・エリア判定にのみ使用
│   └── repos.json                    # repositories[]（type: code|knowledge）
│   # ※ mcp-snippets/ や sandbox-snippets/ は存在しない（§3.5 参照）
├── repositories/                     # ★対象リポを git clone（worktree の元・Read-only。code/knowledge 混在）
│   ├── homehub-backend/  homehub-app-flutter/  homehub-knowledge/  copilot-marketplace/  …
│   └── .claude/settings.json         # OTEL workspace=REPOSITORIES（env のみ）
└── tasks/                            # チケット別ワークスペース（open-task が生成）
    └── HHW-XXXX/
        ├── CLAUDE.md
        ├── docs/task.md              # Notion から転記したチケット全文
        ├── scripts/                  # push-create-pr.sh, add-repository.sh（denyWrite で保護）
        │                             # （※task root 直下に .claude/settings.json は生成されない）
        ├── repositories/             # ★各リポの git worktree（feat/<TICKET_ID>）
        │   ├── homehub-backend/      # worktree（.git は repositories/ 側と共有）
        │   └── homehub-knowledge/    # sparse worktree（designs/ 等のみ）
        └── agents/                   # 各 agents/<role> 直下に空の .git を touch して
                                      # 親リポから隔離（create-workspace.sh:1032-1033、§7-1 に直結）
            ├── worker/               # Tab 1 Claude の CWD
            │   ├── .git              # ← touch（git 境界）
            │   ├── CLAUDE.md         # 役割＋権限境界
            │   ├── .mcp.json         # 選択 MCP（read 権限）
            │   └── .claude/settings.json  # worker sandbox（ガチガチ）
            └── orchestrator/         # Tab 3 Claude の CWD（.git も touch 済み）
                ├── CLAUDE.md         # 司令塔の役割・worker 操作方法
                ├── .mcp.json         # 選択 MCP（read + 選択した write）
                └── .claude/
                    ├── settings.json # orchestrator sandbox
                    └── skills/
                        ├── .worker-target        # ★worker の cmux 送信先を固定（§3.2）
                        ├── send-cmux-command-to-worker/scripts/send-command.sh
                        ├── read-worker-output/scripts/read-output.sh
                        ├── wait-for-worker/scripts/wait-worker.sh
                        └── add-repository-to-worker/scripts/add-repository.sh
```

worker と orchestrator は**同じ code worktree（`tasks/<TICKET>/repositories/`）と `docs/` を共有**する。worker の CWD が `agents/worker/` なので、コードは `../../repositories/<repo>` として参照する。

### 2.3 cmux 3 タブ構成

`open-task` が cmux ワークスペース（名前＝チケット ID）に 3 タブを自動生成する（`create-workspace.sh:1703-1793`）。

| Tab | 名前 | 種別 | CWD | 起動コマンド |
|---|---|---|---|---|
| 1 | **Worker Claude** | Claude | `agents/worker/` | `claude --permission-mode acceptEdits '<initial-prompt>'` |
| 2 | **Terminal** | shell | task root | `pnpm install` / worktree セットアップ / push 等の sandbox 外操作 |
| 3 | **Orchestrator Claude** | Claude | `agents/orchestrator/` | `claude '<orch-prompt>'` |

- Tab 1（worker）が最初に作られ、その **surfaceId(UUID)** を取得して `.worker-target` に固定する（§3.2）。
- Tab 2 では add-repository と、backend の場合 `pnpm i && pnpm build && pnpm local:up-test && pnpm prisma:migrate:local` まで自動投入する。
- cmux が無い環境では起動コマンドをクリップボードにコピーするフォールバックがある。

---

## 3. コア機構の詳細（ここが移植の肝）

### 3.1 git worktree によるマルチリポ展開

- `repositories/<repo>`（clone 済み・Read-only）を**元**に、`tasks/<TICKET>/repositories/<repo>` へ **worktree** を追加する。ブランチは `feat/<TICKET_ID>` 固定。
- `.git` は元リポと共有されるためディスクコストほぼゼロ。
- worktree 作成はサブエージェント/Claude が**直接** `git -C repositories/<repo> worktree add ...` を実行する（スクリプト内の `git worktree` は sandbox の `excludedCommands` にマッチせずブロックされるため）。詳細な分岐（ローカル/リモート/新規ブランチ）は `open-task/SKILL.md` Step 5c 参照。
- **homehub-knowledge は sparse-checkout**（`--cone`）で `dev/task→designs/`、`incident→incidents/ playbooks/` のみ展開。前提として `setup-workspace` が `extensions.worktreeConfig=true` を元リポに設定済みであること（sandbox 内でも `sparse-checkout set` が動くようにするため）。

**移植時の注意**: worktree 元（`repositories/<repo>`）は「親リポ（multi-repo-workspace）にネストした別の git リポジトリ」になる。親リポからは無視/除外する設計が要る（§7）。

### 3.2 orchestrator → worker の協調（**最重要機構**）

worker は sandbox 内で自律実行しているため、orchestrator は**ファイルを直接触らず cmux 経由で指示を渡す**。これを実現する 3 スキル + 固定ファイル。

#### (a) 送信先の固定 `.worker-target`（least privilege の核）

- `open-task` が worker タブを作った直後、その cmux workspace/surface を
  `tasks/<TICKET>/agents/orchestrator/.claude/skills/.worker-target` に書き込む（`create-workspace.sh:1744-1751`）:
  ```
  # open-task が生成。手動編集しないこと。
  WORKER_CMUX_WORKSPACE=<cmux workspace id>
  WORKER_CMUX_SURFACE=<surfaceId(UUID)>
  ```
- **surface は UUID を使う**（コミット `58d8a84`）。理由: UUID は cmux JSON の主キーで、フォーカス/レイアウト変更/リオーダーに左右されず、`"*"` アクティブマーカーや列パースの不安定さが原理的に消える。旧 cmux 用に短縮 ref `surface:NNN` へフォールバックあり。
- orchestrator の settings は `agents/**` を `denyWrite` にしているため、orchestrator 自身は `.worker-target` を**改竄できない**。→ orchestrator は「自分の worker のワークスペースのみ」操作でき、実行時プロンプトで別ワークスペースへ誘導することは不可能。
- 3 スキルとも `--workspace` / `--surface` 引数を**明示的に拒否**（送信先の上書き禁止）。

#### (b) 3 つの協調スキル（すべて sandbox 外実行が必要）

| スキル | スクリプト | 役割 | 内部コマンド |
|---|---|---|---|
| `send-cmux-command-to-worker` | `send-command.sh` | worker へ指示テキスト送信（末尾で `send-key enter` して確定） | `cmux send` + `cmux send-key enter` |
| `read-worker-output` | `read-output.sh` | worker のペイン出力を取得 | `cmux capture-pane --lines N [--scrollback]` |
| `wait-for-worker` | `wait-for-worker.sh` | 指示後、worker が running→idle/needsInput/dead で安定するまで監視し `RESULT` 行を出力 | 直接 exec は `~/.cmux-wait.sh`（arm→wait）のみ。`~/.cmux-state.sh`（agentLifecycle+mtime+pid+デバウンス）は cmux-wait の内部依存 |

**典型ループ**: `send-cmux-command-to-worker "指示"` → 続けて `wait-for-worker` を **`run_in_background: true`** で起動しターンを終える → worker が idle に戻った瞬間に通知 1 回で `RESULT status=... surface=... elapsed=...`（+末尾出力）を受け取る → 内容に応じ次の指示 → 完了後 `create-pr`。これにより「sleep→覗く→sleep…」の自前ポーリングを廃し、トークン/待機を削減。

#### (c) sandbox 外実行の仕組み（`excludedCommands`）

- orchestrator の `.claude/settings.json` の `sandbox.excludedCommands` に、上記スクリプトの**フルパス（`{{TASK_DIR}}/...` 置換後）**を列挙してある（`task-orchestrator/claude-settings.json:46-52`）。これにより sandbox 下の orchestrator でも cmux バイナリ/状態ファイルにアクセスできる。
- **`excludedCommands` はリテラルパス一致**。呼び出しは**必ず `~/` から始まるフルパス**で行う必要がある。`/Users/...`（展開後の絶対パス）・`./scripts/...`（相対）・`bash <path>` はマッチせず **`Exit 126 Operation not permitted`** になる（コミット `4533f4d`）。
- worker 側 `excludedCommands` は **空**（`[]`）。理由（F9 / ADR-0012）: `autoAllowBashIfSandboxed` で自動許可される層に `excludedCommands` を 1 つでも入れると `<excluded>; <任意>` で行全体が無サンドボックス化してしまうため、worker では sandbox を唯一の OS 境界とする。

### 3.3 3 層 sandbox の設定値（要点）

完全な期待値・根拠は現行の 3 リファレンスに詳しい（**移植時に必読**）:
- `root-settings-reference.md` / `orchestrator-settings-reference.md` / `task-settings-reference.md`

移植で外してはいけない防御の骨子:

- **worker**: `autoAllowBashIfSandboxed:true`（sandbox 化された bash は無確認・境界は OS が張る）、`allowUnsandboxedCommands:false`、`excludedCommands:[]`、`network.allowedDomains:[]`（外部送信不可）、`allowLocalBinding:true`（localhost テスト可）。**`permissions.ask=[]`**（PR #170 で chmod/curl/wget の ask を撤去 — worker は人間に prompt せず、越権は「idle に戻って handoff で依頼」に寄せる方針。※ `task-settings-reference.md` の ask=chmod/curl/wget 記述はこの変更前の値なので注意）。`allowWrite` は作業ディレクトリ（`tasks/<TICKET>/repositories`, `docs`）のみが常時。各 worktree の `repositories/<repo>/.git/`（commit 用）は **対話追加した ADDON_REPOS にのみ注入**される（`create-workspace.sh:1456-1474`）。`--repos`/scripted 経路のリポには自動注入されない点に注意（必要なら明示注入 or `update-task-sandbox`）。**リポのソース本体は allowRead のみ＝書換不可で origin を保護**。`agents/**` と `scripts/**` は `denyWrite`。
- **orchestrator（per-task, E）**: bash は `Bash(*)` を持たず、**所定スクリプト（send-command / read-output / wait-for-worker / add-repository-to-worker / push-create-pr）だけを allow**（`task-orchestrator/claude-settings.json:18-22`）。**`network.allowedDomains:[]`・`allowLocalBinding:false`**（push/PR は excludedCommands の `push-create-pr.sh` で sandbox 外実行するため in-sandbox network を持たない）。`agents/**`・`scripts/**` は denyWrite。
  - ※ github 系 network を持つのは **管理コンソール層（B, `orchestrators/task-manager`）**の方（`orchestrator-settings-reference.md`）。B と E を混同しないこと。
- **root**: bash は read-only whitelist（gh/ls/cat/find/echo/mkdir/grep/printf）のみ無確認、変更系は `ask`。`repositories/**` は Edit/Write 不可（ソース保護）。秘密（`~/.ssh` `~/.aws` `~/.config/gh` `~/.config/gcloud` `~/.npmrc`）は Bash（denyRead/credentials）とツール（permissions.deny Read）の両経路で封鎖。
- **共通**: `~/.claude.json`（trust 状態）は read-only。`.claude/**` は自 settings 改竄防止で deny。
- **pre-push hook**: `<ROOT>/.githooks/pre-push` を配置し `core.hooksPath` + `~/.gitconfig` の `includeIf "gitdir:<ROOT>/"` で配下全 repo/worktree に適用。push 先を `bitkey-service` org に限定（F2 対応）。

> 秘密読取・外部送信・ソース改竄・scripts 改竄・自 settings 改竄を全経路で塞ぎつつ、作業ディレクトリ内の編集・ローカルビルド/テスト・commit は無確認で軽快、が設計目標。

### 3.4 タスク作成フロー（`open-task` / `create-workspace.sh`）

Claude Code 経由の体験（`open-task/SKILL.md` が正）。2 phase 構成でスクリプトを呼ぶ。

1. **Step 1**: チケット ID 取得（手入力 / Notion URL / 現在スプリントから選択）。形式 `^[A-Z]+-[A-Za-z0-9_-]+$` を検証。prefix 必須（自動付与しない）。
2. **Step 2**: purpose 選択（`dev`/`incident`/`task`/`project`）。PBI type=`タスク` は `purpose=task`/`preset=none` に自動確定。
3. **Step 2.5**: `purpose=dev` のとき dev_kind（`feature`/`bug`/`improvement`/`unknown`）。PBI type→dev_kind マッピングあり（ストーリー→feature、バグ/QA戻り/社内指摘→bug、改善→improvement）。
4. **Step 3 / 3.5**: preset（UI 概念）選択 → **リポジトリ一覧の最終調整（必ず実行）**。`AskUserQuestion` は options 最大 4 件なので「関連 3 件 + その他」のページング型で追加リポを詰める。**最終的にスクリプトへは `--repos <確定リスト>` で渡す**（`--preset` は渡さない。§3.5 参照）。
5. **Step 4** `--phase init --yes`: ディレクトリ作成 + `.workspace-meta.json` 保存のみ（即終了）。
6. **Step 5（並列）**: メインスレッドで `docs/task.md`（**Notion 本文を転記**）と `CLAUDE.md` を作成、サブエージェント（`run_in_background`）で **git worktree 作成**。worktree 作成のルール（相対パス必須・`git -C` 使用・コマンド連結禁止）は SKILL.md Step 5c に厳密に記載。
7. **Step 6** `--phase finalize --skip-worktrees --yes`: `.claude/settings.json` 生成（OTEL/purpose マージ/enabledMcpjsonServers）、skills インストール、cmux 3 タブ作成 + `.worker-target` 固定、メタ削除。
8. **Step 6.5**: trust 自動設定（`~/.claude.json` の `hasTrustDialogAccepted=true` 等を Claude が直接 jq で書く。sandbox 内スクリプトからは失敗するため）。

### 3.5 purpose × リポ選択 × MCP のマッピング（※SKILL.md と走るコードの乖離に注意）

> **大原則（レビュー反映）**: 移植は「走るコード（`create-workspace.sh` / `setup-workspace.sh` / `references/*`）」の再現。SKILL.md には**未実装の仕様が事実のように書かれている**箇所が複数ある（`--preset`、エリア別 sandbox 合成、purpose 別 MCP テンプレ、playwright 自動 merge）。以下はコード基準の実態。

- **MCP の実態（レビュー反映・重要）**:
  - **purpose 別 `.mcp.json` テンプレは存在しない**。`references/templates` に MCP は `default/mcp.json`（全サーバ入り）と `root/mcp.json` のみ。`create-workspace.sh` が参照する `additional/purposes/<purpose>/default/mcp.json` は全 purpose で不在 → 常に `templates/default/mcp.json` へフォールバック。
  - **`mcp-snippets/` も `type-web/mcp-snippet.json` も実在しない** → playwright の jq merge は**現状は不動作の dead code**。
  - **sandbox 有効（＝既定）では `.mcp.json` 生成自体がスキップ**される（OS ブロックのため。必要時は手動）。
  - `presets/purposes/<purpose>.json` の **`default_mcp_servers`** は **対話モード（`--yes` なし）の multiselect 事前チェックにのみ効く**（`create-workspace.sh:850` の `AUTO_YES=false` 分岐内）。値: **dev=`[notion]`（context7 は入らない。context7 は root/mcp.json 専用）** / incident=`[notion,slack,datadog,google-cloud-logging,sentry]` / task=`[notion,slack]` / project=`[notion]` / alert=`[notion,datadog,google-cloud-logging]`。
  - **`--yes`/finalize 経路（本資料 §3.4 のフロー）では MCP は選択されず**、`enabledMcpjsonServers` は「purpose 別 mcp（不在）→ **root `.mcp.json` の全サーバ**」にフォールバックする（`create-workspace.sh:1558-1567`）。この経路では MCP tool の read/write 個別 allow 注入（`SELECTED_MCP_SERVERS>0` ガード）も起きない。purpose 別の MCP 最小化を効かせたいなら、この分岐の設計変更が要る（§7-8）。
  - **MCP 権限分離**（コミット `1d6c65b`）: worker=選択 MCP の **read のみ** / orchestrator=read + 選択した write。ツール個別 allow を両者の settings に注入（`create-workspace.sh` の MCP 注入部 `~:1540-1617`）。※上記のとおり `--yes` 経路では選択が空なので実際には注入されない。
  - **`alert` は現状 open-task から選べない未接続 preset**。`create-workspace.sh:171` の `PURPOSES=(dev incident task project)` に `alert` は無く、`--purpose alert` は弾かれる（`presets/purposes/alert.json` は `update-task-purpose` 以外から到達しない）。移植時に採否を判断する対象（§7-8 と同種）。
- **リポ選択の実態（レビュー反映・重要）**:
  - **`--preset` フラグはスクリプトに存在しない**。`create-workspace.sh` の引数パーサ（`:669-708`）が受けるのは `--purpose / --dev-kind / --repos / --title / --notion-url / --phase / --sandbox / --no-sandbox / --yes` のみ。`--preset backend` を渡すと `--preset` と `backend` が不正 repo 名として `SELECTED_REPOS` に混入する。
  - **preset は open-task の SKILL.md 上の UI 概念**（Step 3/3.5 でユーザに提示するラベル）で、Claude は最終的に **`--repos <確定リスト>`** としてスクリプトに渡す。
  - `presets/purposes/<purpose>.json` の `default_repos`（dev/incident/alert=`[homehub-backend]` / task=`[copilot-marketplace]` / project=`[]`）は **対話モード（`--yes` なし）の事前チェック用**（`create-workspace.sh:922-968`、`AUTO_YES=false` 分岐の内側）。**`--yes`/scripted 経路で `--repos` を省略するとリポは 0 件**（default_repos は適用されない）。本資料 §3.4 の Step4/6 は scripted 経路なので、リポは必ず `--repos` で明示すること。web/app/full という「preset ファイル」は実在しない。
- **sandbox はエリア別合成をしていない（レビュー反映・重要）**:
  - `sandbox-snippets/` ディレクトリは**存在しない**。worker の sandbox は固定テンプレ `task-worker/claude-settings.json`（`Bash(*)` + `autoAllowBashIfSandboxed`）で、リポのエリアに関わらず同一。`lib/pure/sandbox-config.sh` の `detect_repo_area` 等は定義のみで **create-workspace.sh から呼ばれていない**。
  - `mappings/repo-area-mapping.json` が使われるのは **エリア別スキルのインストール**（`create-workspace.sh:514-542 install_area_skills` → `:1644`）と、web エリア判定のみ。sandbox 権限には影響しない。
- **真実のソース**: 利用可能リポは `references/repos.json`。構造は**単一の `repositories[]` 配列**で各要素に `{name, github, desc, type: "code"|"knowledge"}`。`setup-workspace.sh:73-77` は code/knowledge を区別せず**全て `repositories/` 直下に一括 clone**（別ディレクトリには分けない）。CLAUDE.md のリポ表・選択画面・clone 対象は全てここから動的生成。

### 3.6 push / PR フロー

- worker は network 制限で push/PR 不可。**push/PR は orchestrator（または Root Claude / Tab 2 Terminal）**が担当。
- `create-pr` スキル: 変更のあるリポを検出 → 各リポの `.github/PULL_REQUEST_TEMPLATE.md` 等を読み込み → task.md + diff + commit log から description 生成 → `git push -u origin feat/<TICKET>` + `gh pr create`。
- `gen-create-pr-command`: 未コミット変更を自動 add+commit し、push-create-pr コマンドをクリップボードにコピー（Tab 2 Terminal に貼って人が実行する用。SKILL.md は実行層を明示していないが運用上は worker/task 側で使う）。

### 3.7 テンプレート／参照ファイルの三段パス構造（リポジトリ化で最も改修が要る箇所）

現行はテンプレ・参照が **3 段の場所** を経由する。移植（＝ `npx skills add` からの脱却, §7-2）の核心なのでここを理解しておくこと。

1. **repo-time（真実のソース）**: `copilot-marketplace/plugins/.../skills/setup-workspace/references/templates/…` と `references/{repos.json, presets/purposes/*, mappings/*}`。marketplace リポにコミットされている本体。
2. **install-time**: `setup-workspace.sh` が上記を各ワークスペースの `orchestrators/task-manager/scripts/settings/…` へコピー（`{{WORKSPACE_ROOT}}` 等のプレースホルダはこのタイミングで実パス置換されるものもある）。
3. **runtime**: `create-workspace.sh` は先頭で `SETTINGS_DIR="$SCRIPT_DIR/settings"`（`:50`）を定義し、テンプレ・presets・mappings をここから読む。つまり open-task 実行時に見るのは (2) で配置された実体。

> リポジトリ化では「(1)=(2)＝リポにコミット済み」に畳み込み、`SETTINGS_DIR` をリポ内固定パスへ寄せるのが素直。プレースホルダ（`{{WORKSPACE_ROOT}}`/`{{TASK_DIR}}`）の**実パス置換は実行時のまま**にし、絶対パスをコミットしないこと（§7-4）。

### 3.8 worker↔orchestrator の handoff（`docs/handoff/`、PR #170 で導入。**移植の必須要件**）

cmux ペインの send/read（§3.2）に加えて、**構造化された非同期の受け渡し媒体**として `tasks/<TICKET>/docs/handoff/` を使う。これが「2 エージェント運用モデル」の中核。

- **worker の idle-not-exit プロトコル**（重要）: worker は起動後 `docs/task.md` を読んで計画→順次実行し、**各ステップ完了時・ブロック時・全完了時に `docs/handoff/` へ 1 ファイル追記して、プロセスは終了せず idle に戻って待機**する（exit しない。次の指示は orchestrator から cmux で届く）。越権が要る操作（push/PR・パッケージ追加・network・agents/scripts 書込）は**自分で試さず** `status: blocked` + `requests` で依頼する。
- **追記専用・イミュータブル**: 1 メッセージ 1 ファイル、既存は書き換えない。ファイル名 `YYYYMMDD_HHmmss_NNN_<from>.md`（`NNN`=3 桁 seq＝順序/鮮度/ID）。`<from>` は `worker` / `orchestrator`。
- **状態はファイルから導出**（mutate しない）: 最新 worker 状況＝最大 seq の `*_worker.md`(type: report) / 未処理依頼＝対応する `*_orchestrator.md`(type: result, refs: <req-id>) が無い `request` / 既読＝orchestrator の最大 seq。
- **worker report の形**（YAML 風・抜粋）:
  ```
  type: report
  status: blocked        # in_progress | awaiting_next | blocked | complete | failed
  task_ref: docs/task.md step4
  summary: <何をしたか / 現状>
  requests:              # 越権依頼がある場合のみ
    - id: req-004-1
      action: push_and_pr   # push_and_pr | install_package | other
      repo: <repo>
      branch: feat/<TICKET>
      pr_title / pr_body: …  # PR 文言は worker が下書き（proposed_pr）
  ```
- **orchestrator の処理ループ**: send-command で依頼 → 直後に `wait-for-worker.sh` を `run_in_background` で起動しターンを終える → 完了通知の RESULT を確認 → `docs/handoff/` の最新 `*_worker.md` を **Read ツールで**読む → 未処理 `requests` を処理:
  - `push_and_pr`: worker の diff を検証 →（必要なら**人間承認**）→ `scripts/push-create-pr.sh <repo> --title … --body …`
  - `install_package` 等の依存追加: **自分では実行せず**ユーザーに確認 →**ユーザーが Terminal で実行**
  - 実行後 `*_orchestrator.md`（type: result, refs: <req-id>, status: done|failed|deferred）を追記 → worker に次の指示。`status: complete` まで繰り返す。
- **build / test / install の分担**（PR #170 で明確化）: 初期化（`pnpm i` / 初回 build / docker 起動）は add-repository 時に **Terminal** で実行（Claude は関与しない）。サイクル内の lint/build/test は **worker**（sandbox 内・既存 deps 前提）。**パッケージ追加＋`pnpm i` は worker も orchestrator も不可＝ユーザーが Terminal で実行**。
- **floundering 防止（orchestrator の必須ガイド）**: orchestrator は task dir 配下（`agents/`・`scripts/`・`.worker-target`・各 skill 中身）を `ls`/`find`/`cat`/`git`/`hexdump` 等で **bash から直接覗かない**（sandbox `denyRead` で `Operation not permitted` になり「`.worker-target` が空」等と誤認する）。ファイル確認は **Read ツール**（`docs/`・`repositories/` は読取可）、worker 操作は所定スクリプト（surface はスクリプトが解決するので `.worker-target` を自分で読む必要はない）に任せる。
- `docs/` は task ローカルなので、handoff は PR 差分（`repositories/` 側）に混入しない。

---

## 4. スキル一覧（移植対象）

| スキル | 実行層 | 役割 |
|---|---|---|
| `setup-workspace` | Root | 初期化。`repositories/` の clone、root/origins/knowledge の settings 配置、templates 同期 |
| `open-task` | Root/Orchestrator | チケットから task を作成（cmux 3 タブ、worktree、agents/worker+orchestrator 生成） |
| `add-repository` | Orchestrator/Terminal | task に worktree を追加 |
| `add-repository-to-worker` | Orchestrator | worktree 追加 + worker へ cmux 通知 |
| `send-cmux-command-to-worker` | Orchestrator | worker へ指示送信（`.worker-target` 固定先） |
| `read-worker-output` | Orchestrator | worker ペイン出力を capture |
| `wait-for-worker` | Orchestrator | worker 完了待ち（`run_in_background` 前提）。実スクリプトは `wait-for-worker.sh` |
| `create-pr` | Orchestrator/Root | push + PR 作成 |
| `gen-create-pr-command` | Worker | push-create-pr コマンドをクリップボードへ |
| `open-code` | Worker | VSCode でファイルを開く |
| `list-task` / `close-task` | Root/Orchestrator | task 一覧 / 削除（close は worktree prune 含む） |
| `update-task-purpose` | Root | purpose/dev_kind 変更（CLAUDE.md 再生成・sparse 切替・OTEL 更新） |
| `update-task-sandbox` | Root | sandbox 権限追加。`--add-git-access`（git read/fetch/push(ask)+SSH agent+git config allowRead）/ `--add-domain <d>` / `--add-allow "Bash(...)"` / `--add-ask` / `--show`。**task 内から自分の settings は変更不可**なので Root から実行 |
| `sync-workspace-settings` | Root | テンプレ・設定の最新化 |
| `start-task` | Root | task.md 起点で Claude を起動。**スクリプトを使わず Claude が Bash で直接 cmux を叩く**（sandbox 内からは cmux バイナリに触れないため。SKILL.md に CRITICAL 明記） |
| `cmux-diff-viewer` | Worker/Orchestrator | cmux 上で diff を閲覧する |

---

## 5. 前提ツール・環境

- **必須**: `git`, `jq`, `curl`, Node.js 16+（`npx skills` 用。リポジトリ化で不要にできる可能性あり→§7）, GitHub への SSH アクセス（`git@github.com:bitkey-service/...`）。
- **任意**: `cmux`（3 タブ協調に必須級。無い場合はクリップボード fallback で単一 Claude 運用）、`NOTION_API_TOKEN`（PBI 自動取得）、macOS（`pbcopy` / sandbox-exec / `--notify`）。
- **`wait-for-worker` 前提**: `~/.cmux-wait.sh` と `~/.cmux-state.sh` が存在すること（`CMUX_WAIT_SCRIPT` で上書き可）。これらは現状ホーム直下に置かれる外部スクリプト。**移植時にどこから配布/生成するか要検討**（リポジトリに含めて配置する等）。

---

## 6. cmux 連携で踏みやすい落とし穴（現行が対処済み・移植で必ず再現すること）

1. **`excludedCommands` はリテラル一致** → cmux 系スクリプトは必ず `~/` フルパスで呼ぶ。相対・展開済み絶対・`bash <path>` は Exit 126。
2. **worker の `excludedCommands` は空**にする（F9: 自動許可層で excludedCommands があると行全体が無サンドボックス化）。
3. **cmux send はテキスト末尾改行だけでは確定しない** → `send-key enter` を別途送る（`send-command.sh:98-102`）。
4. **surface は UUID で固定**（`--id-format uuids`）。`"*"` アクティブマーカーや列位置に依存しない。
5. **worktree 作成は Claude/サブエージェントが直接実行**（相対パス・`git -C`・コマンド非連結）。スクリプト内 `git worktree` は sandbox にブロックされる。
6. **trust 未設定だと `permissions.allow` が全無視**され sandbox 保護が不完全（`Ignoring N permissions.allow entries ...` が出る）。open-task 後に trust を確認/設定する。
7. **`--command` には必ず `cd <絶対パス> &&`** を含める（省略するとホームで起動し task の設定を読まない）。

---

## 7. リポジトリ化にあたって「決めること」（設計論点）

別エージェントは着手前に以下をユーザと合意すること。現行実装には答えが無い、または方式変更が必要な点。

1. **`repositories/` 配下の対象リポの git 管理方法**（最重要）
   - 案 A: `.gitignore` で `repositories/` と `tasks/` を丸ごと無視（現行の思想に近い。生成物扱い）。
   - 案 B: git submodule で対象リポを固定参照（バージョン再現性は上がるが worktree 運用と相性・運用コストを要検証）。
   - 案 C: リストだけコミット（`repos.json`）し、clone は `setup-workspace.sh` に任せる（現行と同じ）。
   - **推奨初期値: 案 A + 案 C の併用**（`repos.json` はコミット、実体 clone と tasks 生成物は ignore）。

2. **スキル解決を `npx skills add` から切り離すか**
   - リポジトリ化の主目的が「clone して即使える」なら、スキルはリポジトリ内 `.claude/skills/`（or `skills/`）に**コミット**し、`open-task` finalize の skills インストール工程を撤廃 or 冪等コピーに置換する。
   - ただし現行は「スキルの Base directory をスキル提示文から受け取る」前提のパスが各所にある（`setup-workspace/SKILL.md` の実行パス規則参照）。リポ内固定パスへ寄せる改修が要る。

3. **`~/.cmux-wait.sh` / `~/.cmux-state.sh` の配布**（§5）。リポジトリに同梱してセットアップ時に配置する形にするか、外部前提のままにするか。

4. **`{{WORKSPACE_ROOT}}` / `{{TASK_DIR}}` の置換タイミング**。現行はテンプレのプレースホルダをスクリプトが実パスに置換する。リポジトリ化後も clone 先が可変なので、置換は**実行時**に行う設計を維持する（絶対パスをコミットしない）。

5. **org/リポ名のパラメータ化**。現行は `bitkey-service` org と homehub 系リポ名がハードコード気味（`repos.json`・pre-push hook・pnpm セットアップ分岐）。pre-push hook は `ALLOWED_ORGS="bitkey-service"` のみ許可するが、`repos.json` の `bitkey-csm` は org `continuous-connect` のため**現状 hook で push がブロックされる**（例）。汎用リポジトリにするなら許可 org リストを含めて設定ファイルへ外出しする。

6. **単一リポでの複数タスク並行**。cmux workspace は task ごと。`tasks/` 配下が増えるので、`list-task` / `close-task` / 古い worktree の掃除（`git worktree prune`）運用を明記。

7. **root 自身の git**。`multi-repo-workspace` リポ自体のブランチ運用（構成変更を PR でレビュー）と、配下 worktree の push を pre-push hook で org 制限する二重構造を整理する。加えて `agents/worker/.git`・`agents/orchestrator/.git` を `touch` して親リポから隔離している仕掛け（`create-workspace.sh:1032-1033`）を、リポジトリ化後の `.gitignore`/境界設計とどう両立させるか。

8. **SKILL.md / spec と実スクリプトの乖離を「実装するか捨てるか」決める**（レビューで判明）。文書化されているが**未実装 or dead code** の機構: (a) `--preset` フラグ、(b) エリア別 sandbox スニペット合成（`sandbox-snippets/` + `detect_repo_area`）、(c) purpose 別 `.mcp.json` テンプレ（`templates/purposes/<purpose>/.mcp.json` は不在→`default/mcp.json` フォールバック）、(d) web リポでの playwright 自動 merge（`mcp-snippets/`・`type-web/mcp-snippet.json` が不在で不動作）。移植時にこれらを ① 仕様通り実装する / ② 現行の実挙動（`--repos`＋`default_repos`、固定 sandbox テンプレ、`default/mcp.json`＋`default_mcp_servers`）に合わせて文書を正す、のどちらに倒すか最初に決める。**移植は「走るコード」の再現が基本**なので既定は ② を推奨。

9. **テンプレ三段パス（§3.7）の畳み込み**。repo-time / install-time / runtime の 3 段を、リポジトリ化後は「コミット済み実体を `SETTINGS_DIR` 相当の固定パスから読む」1〜2 段に簡素化する。`setup-workspace.sh` のコピー工程（`orchestrators/task-manager/scripts/settings/` への配置）をどこまで残すか。

10. **`orchestrators/task-manager`（管理コンソール層 B）をリポジトリ化後どこに置くか**。現行は setup-workspace が生成する層だが、リポジトリ化すると「リポ直下でそのまま管理スキルを動かす」形にできる可能性がある。B と Root（A）を統合するか分離維持するかを決める。

11. **マルチ worker アーキタイプ化（§10。合意済みの将来設計）を移植の初期スコープに含めるか**。現行は「1 orchestrator + 1 worker（固定 `.worker-target`）」。将来は「1 orchestrator + 用途別・権限別の複数 worker（`.worker-targets` マップ + `spawn-worker`）」へ拡張する方針が合意済み。リポジトリ化と同時に §10 の構造で作るか、まず 1:1 を移植してから拡張するかを決める（推奨: まず 1:1 を移植して end-to-end を通し、その後 §10 を段階導入）。

---

## 8. 参照ファイル一覧（現行実装・読む順）

すべて `copilot-marketplace/plugins/homehub-multi-repo-workspace-v2/` 基準。

**まず全体把握**
- `README.md` … 概要。冒頭の 3 層表は簡略化（Root/Orchestrator/Task）だが、「Worker / Orchestrator の役割分担と handoff」節（PR #170 追記）が現行の 2 エージェント運用の正。※「orchestrators/task-manager」は死んだ層ではなく管理コンソール層（§2.1-B）で現役
- `user-guide.md` … 3 シナリオの手順（人間/AI/Script の分担が具体的）
- `plugin.json` … プラグイン定義

**設定の期待値と根拠（sandbox の設計思想。移植必読）**
- `root-settings-reference.md` … Root 層（A）
- `orchestrator-settings-reference.md` … **管理コンソール層（B, `orchestrators/task-manager`）**。per-task の司令塔（E）ではない点に注意
- `task-settings-reference.md` … agents 分割前のモデル。**現状の per-task Worker（D）の正はテンプレ `task-worker/claude-settings.json`**
- per-task の正テンプレ: `references/templates/task-worker/claude-settings.json`（D）/ `references/templates/task-orchestrator/claude-settings.json`（E）
- `verification-guide.md`

**orchestrator↔worker 協調（本システムの肝）**
- PR #170（merged）… 2 エージェント運用モデル + `docs/handoff/` の全容（worker/orchestrator の CLAUDE.md 生成差分・handoff フォーマット・build/test/install 分担）。`gh pr view 170` / `gh pr diff 170`
- `skills/send-cmux-command-to-worker/{SKILL.md,scripts/send-command.sh}`
- `skills/read-worker-output/{SKILL.md,scripts/read-output.sh}`
- `skills/wait-for-worker/{SKILL.md,scripts/wait-for-worker.sh}`（※ファイル名は `wait-for-worker.sh`）
- `create-workspace.sh` の worker/orchestrator CLAUDE.md 生成部（`~:1345-1470`）… handoff プロトコル・floundering 防止ガイドの実文言
- `skills/open-task/scripts/create-workspace.sh` … 特に **引数パーサ `:670-712`（`--preset` 無し）/ agents dir `:1024-1033`（`.git` touch 含む）/ worker・orchestrator settings/MCP 生成 `:1284-1547` / cmux 3 タブ・.worker-target 固定 `:1715-1823`**（行番号は目安。多少のズレあり）

**タスク作成フローと設定生成**
- `skills/open-task/SKILL.md` … Step 1〜7 の全手順（AskUserQuestion 制約・worktree ルール含む）
- `skills/setup-workspace/SKILL.md` + `scripts/setup-workspace.sh`
- `skills/open-task/scripts/lib/effects/cmux.sh` … 旧 3 タブ生成（参考）
- `skills/open-task/scripts/lib/{pure,effects}/*` … notion 取得・sandbox 設定・trust の純粋関数/副作用分離（bats テストあり）

**テンプレート（生成物の実体）**
- `skills/setup-workspace/references/templates/task-worker/claude-settings.json`
- `skills/setup-workspace/references/templates/task-orchestrator/claude-settings.json`
- `skills/setup-workspace/references/templates/root/{claude-settings.json,CLAUDE.md,githooks/pre-push,mcp.json}`
- `skills/setup-workspace/references/templates/default/*`
- `skills/setup-workspace/references/templates/additional/purposes/**`（purpose/dev_kind 別 CLAUDE.md・task.md・initial-prompt.md・skills.json）
- `skills/setup-workspace/references/{repos.json（repositories[]+type）, presets/purposes/*.json（default_repos）, mappings/*}`

**その他スキル**
- `skills/create-pr/SKILL.md` / `skills/gen-create-pr-command/SKILL.md`
- `skills/add-repository{,-to-worker}/{SKILL.md,scripts/add-repository.sh}`
- `skills/{list-task,close-task,start-task,open-code,cmux-diff-viewer,update-task-purpose,update-task-sandbox,sync-workspace-settings}/`

**設計背景（存在すれば・より深い ADR）**
- `repositories/homehub-knowledge/ai-tooling/claude-code/`（`01-policy/` `02-behavior-facts/` `03-verification-log/` `04-adr/`）… sandbox の挙動事実・ADR（0002 git 除外, 0003 autoAllow, 0009 orchestrator, 0010 root, 0011 pre-push, 0012 F9, 0013 Option B 等）。**移植の判断根拠はここに集約**。clone 済み環境でのみ参照可。

---

## 9. 最初の一歩（推奨着手順）

1. §7 の設計論点をユーザと合意（特に 1・2）。
2. 現行 v2 プラグインを `multi-repo-workspace` リポジトリの雛形へ**構造ごとコピー**（scripts/ templates/ skills/ + root の .claude/CLAUDE.md）。プレースホルダ置換は実行時のままに保つ。
3. `setup-workspace.sh` を「リポジトリ内で完結」する形に調整（repos.json から clone、root/origins/knowledge settings 配置、cmux-wait 系の配置）。
4. `open-task`（create-workspace.sh）の skills インストール工程を、リポ内 `.claude/skills/` 前提へ置換。
5. 1 チケットで end-to-end 検証: open-task → worker 自律着手 → orchestrator から send/wait/read → commit → create-pr。`verification-guide.md` の観点で確認。worker 起動時の実プロンプトは `templates/additional/purposes/<purpose>/default/initial-prompt.md`（dev の実体は `../../docs/task.mdを参照して開発を進めてください` の 1 行）なので、中身が意図通りかも見る。sandbox 無し環境への移植も想定するなら `templates/default/claude-settings-no-sandbox.json`（`--no-sandbox` 経路）を確認。
6. sandbox 3 層が期待値どおりか、各 `*-settings-reference.md` の早見表で照合。
7. （任意・段階導入）§10 のマルチ worker アーキタイプへ拡張。まず 1:1 を通してから。

---

## 10. マルチ worker アーキタイプ設計（合意済み・**未実装**。移植の将来ゴール）

> 現行は「1 タスク = orchestrator 1 + worker 1（固定 `.worker-target`）」。この節は、worker を**用途別に権限プロファイル化し、orchestrator が『どの型の worker を立て、何を頼むか』をルーティングする**という、ユーザと合意済みの拡張設計。**まだコードには無い**が、リポジトリ化の主目的の一つなので設計として盛り込む。実装は 1:1 移植を通した後の段階導入を推奨（§7-11）。

### 10.1 2 つの独立軸を分ける

| 軸 | 意味 | 変えるもの | コストへの影響 |
|---|---|---|---|
| **スレッド増（同一プロファイル）** | 同じ権限の worker を N 個＝並列スケール | 数だけ（型は同じ） | **同時走行 worker 数 × コンテキスト**に比例（ここが主コスト） |
| **プロファイル変更** | 用途に応じて権限を変えた worker | 権限プロファイル（型） | 型は JSON 定義なので増やしても実行コストは増えない |

→ **型は少数（暗記できる粒度）に固定し、数は必要時だけ増やす**が基本方針。read 主体の型（reader/researcher）は安全なので並列調査に積極利用、coder は編集競合回避のため基本 1〜少数。

### 10.2 権限プロファイルの「ノブ」

型はこの組み合わせで表現する: **FS read**（cwd のみ / +docs / +task repos / +root repos 参照 / `/`＝非推奨）・**FS write**（なし / docs のみ / task repos+docs）・**Bash(sandbox内)**（build/test あり / 読取のみ / なし）・**git ローカル**（worktree commit あり / なし。※push は常に orchestrator）・**MCP**（なし / 選択の read /(documenter のみ notion write)）・**network**（なし / WebSearch・WebFetch / 特定ドメイン）。

### 10.3 4 コアアーキタイプ（確定）

| 型 | 用途 | FS read | FS write | Bash(sandbox) | git local | MCP | WebSearch/Fetch |
|---|---|---|---|---|---|---|---|
| **coder** | 実装・リファクタ・バグ修正（現行 worker 相当） | root 参照+task repos+docs | task repos+docs | ✅ | ✅ commit | 選択の read | ✗ |
| **reader** | コード読解・影響調査・レビュー観点抽出 | root 参照+task repos+docs | なし | 読取用途のみ（allowWrite 空） | ✗ | ✗ | ✗ |
| **researcher** | 仕様/インシデント一次調査・外部情報収集 | root+task repos+docs | docs のみ（調査メモ） | 限定 | ✗ | 選択の read | ✅ |
| **documenter** | 計画・設計・ドキュメント・PBI 整備（コードは書かない書き物成果物全般） | root+task repos+docs | docs のみ | 最小 | ✗ | notion 等 read（必要なら write は flag） | ✗ |

- **共通**: `denyRead:["~"]`、`agents/**`・`scripts/**` は denyWrite、秘密情報 deny、**push は不可**（orchestrator の `push-create-pr.sh` 経由）。
- 命名は `-er の役割名`で統一（coder / reader / researcher / documenter）。※「doc」「planner」「architect」は検討の末に却下（documenter が「ドキュメント全般の作成」責務を最も誤解なく表す、という結論）。
- 細かな差異は**型を増やさずフラグで**吸収する想定: `--no-ref`（root 参照なし）/ `+mcp:<server>` / `+git-local` / `+websearch` 等。型の爆発を防ぐ。

### 10.4 マルチ worker 機構（設計イメージ）

- **配置**: worker ごとに `agents/<name>/`（例 `agents/documenter`, `agents/coder-1`）。各自 settings（型プロファイル）＋ `.claude/skills`。`repositories/` と `docs/` は全 worker 共有（権限だけ違う）。
- **spawn-worker スキル**（orchestrator 用・新規）: `spawn-worker --type <archetype> [--name <name>] [flags]` — 型テンプレから settings 生成 → cmux タブ作成・claude 起動 → 送信先マップに登録。
- **`.worker-target` → `.worker-targets` へ拡張**: 単一固定から `name → {workspace, surface, type}` のマップへ。`send-cmux-command-to-worker` / `read-worker-output` / `wait-for-worker` を **`--worker <name>` 選択**に拡張（送信先は**登録済みマップ内に限定**＝least-privilege 維持。任意ワークスペースは指定不可）。
- 型テンプレは `references/templates/task-worker-<type>/claude-settings.json` として 4 種用意し setup-workspace で同期。

### 10.5 起動時パイプライン（documenter-first）

1. **open-task 時**: orchestrator ＋ **documenter** を起動。documenter が `docs/task.md` を読み、計画を `docs/plan.md`（＋必要な設計/ドキュメント）に作成 → handoff で完了通知（`wait-for-worker` が活きる）。
2. orchestrator が `docs/plan.md` を Read → 種別を判断し、必要な型を `spawn-worker`:
   - 実装 → **coder** を立て plan に沿って修正依頼
   - 事前調査が要る → **researcher** を立て調査依頼（結果も `docs/` へ）
   - 影響調査 → **reader** を（必要に応じ並列で）
3. `docs/`（特に `docs/plan.md` / `docs/handoff/`）を**ハンドオフ媒体**にして documenter→coder/researcher が計画・調査結果を受け渡す。
4. 各段で最小権限の型を割り当てる「計画 →（調査）→ 実装 → 検証」の明快なパイプライン。

### 10.6 塩梅の指針（過剰分割を避ける）

- 型は **4〜5 に固定**（暗記できる粒度）。それ以上はフラグで微調整。
- worker 数は**必要な並列度・分離が要る時だけ**増やす（コストは数に比例）。
- 起動時は「orchestrator + documenter のみ」が既定。dev で最初から coder も欲しい場合は `--with coder` 等で選べる余地を残す。
- **未確定の論点**（実装前に詰める）: (a) coder に MCP read を残すか（現行踏襲で残す想定）、(b) documenter の notion write を既定にするかフラグにするか、(c) `.worker-targets` の権限境界（他 worker のペインを read できてよいか）、(d) 並列 worker が同一 worktree を編集する際の競合回避（型で coder を単数に寄せる運用で回避）。