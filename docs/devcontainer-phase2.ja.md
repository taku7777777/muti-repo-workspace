# Phase 2 — publish broker(push できる唯一のもの)

Phase 0 は coder を caged にした(ネットワーク境界、push クレデンシャル無し、GitHub egress 無し)。
Phase 1 はそこに、**publish stub** で終わる決定論的な plan→implement→review⇄fix→test→approve
パイプラインを与えた。Phase 2 はその stub を **publish broker** に置き換える:
push できる**唯一の**コンポーネントである小さな TypeScript サービスだ。

coder はトークンも、push 能力も、GitHub egress も**得ない**。得るものは1つ:
`{ repo, branch, title, body }` という**型付き intent** を送る **unix socket** だけ。
重要なものはすべて — 人間が見る diff、push 先、承認、push — 信頼された側で git オブジェクトから
**sha で**計算される。coder が言うことや、coder が書き込める config・ref・remote・ポリシーファイルからは
決して計算しない。

> 🇬🇧 English: [devcontainer-phase2.md](devcontainer-phase2.md)

## 中核原則(v2 の再設計)

broker は **coder が書き込めるワークツリー全体** — bind マウントされた repo(その `.git`、
`.gitattributes`、`config/`、`.githooks/` を含む) — を**信頼できない入力**として扱う。
coder が制御する git config を決して実行せず、coder が書き込めるパスからポリシーを決して読まず、
coder が書き込める ref から ground truth を決して導かず、coder が制御する remote へ決して push しない。

```
   caged coder container                        broker container (own, on `egress`)
 ┌──────────────────────────┐  shared         ┌────────────────────────────────────────┐
 │ harness/orchestrator      │  named-vol      │ broker  (holds the GH token)            │
 │  └ publish.ts ───────────── unix socket ───►│  1. typed request only                 │
 │    { repo,branch,         │  broker-sock    │  2. TRUSTED policy (baked file)         │
 │      title,body }         │  publish.sock   │  3. SCAN coder .git config → fail-closed│
 │  NO token                 │                 │  4. read HEAD/branch/clean (isolated)   │
 │  NO github egress         │                 │  5. parse origin → validate → build URL │
 │  NO push capability       │                 │  6. FETCH branch → GROUND-TRUTH diff    │
 │  caged (internal) network │                 │     (broker-private scratch repo)       │
 └──────────────────────────┘                 │  7. HUMAN approves (target+sha shown)   │
      cap_drop ALL                             │  8. re-validate → push sha → gh pr create│
      internal network only                    └────────────────────────────────────────┘
                                                    egress network; token in ITS env only
```

## 6つの厳格な要件(および各要件がどこに存在するか)

**F1 — git-config-injection による RCE + トークン隔離。** 読み取り側の git コマンドはすべて、
`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_SYSTEM=/dev/null`、`-c core.fsmonitor=false`、
プロンプト/pager を無効化し、**env にトークン無し**で実行する。diff には
`--no-ext-diff --no-textconv` を付ける。コマンドはすべて argv 配列(シェル無し)。
global/system の null 化は coder の **local** な `.git/config` を無効化**しない**ため、
broker はまず local config を**スキャン**し、exec/リダイレクト可能なキー
(`core.fsmonitor`、`filter.*`、`url.*.insteadOf`、`http.*`、`credential.*`、`core.hooksPath`、
`include.path`、…)があれば **fail-closed**(`untrusted_config`)する — こうして coder の config が
`status`/`log`/`diff` によって実行されることは決してない。`broker/src/git.ts`
(`isolatedEnv`、`readEnv`、`scanUntrustedLocalConfig`)を参照。

**F2 — 信頼されたポリシー、coder は書き込めない。** allowlist
(`allowed_push_orgs` / `allowed_push_hosts` / `branch_prefix`)は `BROKER_POLICY_FILE`
(broker 所有のファイル)からロードする。それが欠落・不正、**または coder が書き込める
worktrees/workspace ツリー内に解決される**場合は fail-closed(両パスを `realpath` で解決して
チェックするので、symlink で紛れ込ませることはできない)。bind マウントされた
`config/workspace.json` はリクエスト時に**決して**読まない。強制は**プロセス内**で行う。
pre-push hook や `jq` には依存しない。`broker/src/config.ts` と `config/broker-policy.json`
(イメージにベイクされる)を参照。

**F3 — ref の衛生 / diff の目くらまし無し。** ground truth を描画するために broker はまず、
構築・検証された URL から(トークン付きで)ブランチを **`git fetch`** し、**scratch repo** 内の
broker 専用 ref に取り込む。次に、その**取得したての ref** に対して unpushed セットと diff base を
計算する(まっさらな新規ブランチには empty-tree `4b825dc…`)— ローカルの `refs/remotes/*` に対しては
決して行わない。すべての git 呼び出しは完了を検証する(`ok && !truncated`)。git エラーや
`maxBuffer` オーバーフローは強い fail-closed(`render_incomplete`)であり、切り詰められた/空の
「ground truth」が人間に示されることは決してない。`broker/src/git.ts`(`renderGroundTruth`)を参照。

**F4 — 承認された sha を、構築・検証された URL へ push する。** origin 文字列を `host/org/repo` に
パースし、ポリシーに対して検証し、正規の `https://<host>/<org>/<repo>.git` URL を**検証済みの
部品から再構築**する(埋め込みクレデンシャル、余分なパスセグメント、insteadOf 形の入力を無効化)。
push は、config を broker が制御する **broker 専用の scratch bare repo** から実行し、coder の
オブジェクトへは `GIT_ALTERNATE_OBJECT_DIRECTORIES` 経由で **sha で**到達する — こうして coder の
ローカルな `insteadOf` / `pushInsteadOf` / `http.proxy` / `credential.helper` が push をリダイレクト
したりトークンを捕捉したりすることは**決してできない**。厳密なオブジェクトを push する:
`git push <constructedURL> <approvedSha>:refs/heads/<branch>`。承認サマリーは、解決された
host/org/repo/URL **と** sha を表示する。`pushApprovedSha` と `approve.ts` を参照。

**F5 — キャンセル安全な、直列の人間ゲート。** socket の read timeout は**リクエスト前の read だけ**を
制限する。リクエスト行がディスパッチされると(`dispatched` ガードが接続ごとに**ちょうど1つ**を保証)、
その timeout はクリアされ、人間ゲートは `AbortController` に結線された**別の**予算で制限される。
この `AbortController` は保留中の承認をキャンセルして失敗を返す — そして承認後のパスは同期的なので、
broker は**失敗を返した後に push することは決してない**。ハンドラは完全に**直列**:
`busy` はハンドラ全体(検証 + 人間ゲート + push)が完了するまで保持される。busy 中の2つ目の接続には
即座に `busy` を返す。`broker/src/server.ts` を参照。

**F6 — push の直前に再検証する。** sha バインド後、push の直前に — **同期的に、プロセス内で** —
broker は local config を再スキャンし、ターゲットを再解決・再検証し(host/org allowlist + 再構築 URL が
承認済みのものと一致する必要がある)、`HEAD` がまだ承認済みの sha であることを確認する。不一致や
パース失敗があれば push せずに中断する。`broker/src/handler.ts`(step 9)を参照。

## ファイル

| File | Role |
|---|---|
| `broker/src/index.ts` | エントリポイント。TRUSTED ポリシーを fail-closed でロードし、socket サーバを起動し、承認予算を結線する。 |
| `broker/src/server.ts` | Unix-socket リスナー。接続ごとに1行をディスパッチ、直列の `busy`、read-timeout と中断可能な人間ゲート予算の分離(F5)。 |
| `broker/src/handler.ts` | 決定手続き: parse → policy → config スキャン → 事実を読む → URL 検証+構築 → fetch+ground-truth → 承認 → 再検証 → push → PR(F6)。 |
| `broker/src/git.ts` | 隔離された読み取り側 git、local-config スキャン、origin パース + 正規 URL、object alternates 経由の scratch-repo fetch/ground-truth/push、`gh pr create`。 |
| `broker/src/config.ts` | TRUSTED ポリシーローダー(fail-closed、coder-tree 包含チェック)、トークン/パス/予算は broker 自身の env から。 |
| `broker/src/approve.ts` | 人間ゲート — ground truth + 解決されたターゲット + sha を描画、中断可能なプロンプト。 |
| `broker/src/types.ts` | ワイヤ契約 + zod 検証 + 失敗コード。 |
| `config/broker-policy.json` | 信頼された allowlist。ビルド時に broker イメージにベイクされる。 |
| `harness/src/publish.ts` | コンテナ内クライアント。intent を組み立て、送信し、結果を報告する。トークン無し、push 無し。 |

## 設定(broker env、信頼された側のみ)

| Env | Default | Meaning |
|---|---|---|
| `BROKER_GITHUB_TOKEN` (or `GH_TOKEN`/`GITHUB_TOKEN`) | — | 短命の push トークン。fetch/push/PR にのみ付与、読み取りからは剥がす。 |
| `BROKER_POLICY_FILE` | *(required)* | 信頼された allowlist ファイル。未設定/不正/coder ツリー内なら fail-closed。イメージ内では `/etc/mrw-broker/policy.json` にベイク。 |
| `BROKER_WORKTREES_DIR` | `<ws>/repositories` | bare 名の worktree `<dir>/<repo>` のベースディレクトリ(coder が書き込める、信頼できない)。 |
| `BROKER_CODER_TREE` | self-located `<ws>` | ポリシーファイルが内側に存在してはならない、coder が書き込めるツリー(F2)。コンテナ: `/workspaces/muti-repo-workspace`。 |
| `BROKER_SOCKET_PATH` | `<ws>/.devcontainer/run-broker/publish.sock` | broker が listen する場所。コンテナ: 共有 named volume の内側。 |
| `BROKER_APPROVAL_TIMEOUT_MS` | `1800000` (30 min) | 人間ゲートの予算。`0` = 無制限。 |

coder 側は `BROKER_SOCKET=/run/broker/publish.sock` だけが必要
(**未設定 ⇒ Phase-1 stub、push 無し**)、および任意で `PUBLISH_REPO`/`PUBLISH_BRANCH`
(broker が両方を再導出・再検証する)。

## デプロイのデフォルト — broker を**専用**コンテナにする(推奨)

ポータビリティ + トラスト分割: broker は `egress` ネットワーク(github アクセス)上の compose
サービスとして動き、トークンを**自身の** env に保持し、Docker **named volume**(`broker-sock`)
経由で socket を coder と共有する。これは macOS の Docker Desktop で機能する。macOS では、
ホストプロセス + ホストパス bind マウントの unix socket はコンテナ境界を**越えない**からだ。
coder は `caged`(internal)ネットワークのみに留まり、github egress も**無し**、トークンも**無し**。
唯一の新しい surface は共有 socket だけ。

```bash
# 1. Coder key goes in .env; the broker token goes in the SHELL, never in .env.
cp .devcontainer/.env.example .devcontainer/.env      # ANTHROPIC_API_KEY for the coder
# Export the push token in your shell so compose interpolates it into the BROKER
# ONLY. Do NOT append it to .devcontainer/.env — that file is the coder's env_file,
# so a token there would leak into the caged coder (which must hold no token).
export BROKER_GITHUB_TOKEN=ghs_xxx

# 2. Edit config/broker-policy.json (allowed_push_orgs/hosts, branch_prefix). It is
#    baked into the broker image at build, so the runtime coder cannot alter it.

# 3. Bring it all up (same shell, so $BROKER_GITHUB_TOKEN is in scope). The broker
#    builds from .devcontainer/broker.Dockerfile.
docker compose -f .devcontainer/docker-compose.yml up -d --build

# 4. The coder is still fully caged (no github egress, no token):
docker compose -f .devcontainer/docker-compose.yml exec coder \
  bash scripts/egress-selfcheck.sh

# 5. Attach a terminal to the broker so you can answer approval prompts:
docker compose -f .devcontainer/docker-compose.yml attach broker
#   [broker] policy OK (/etc/mrw-broker/policy.json) — hosts=[github.com] …
#   [broker] listening on /run/broker/publish.sock

# 6. Run the pipeline in the coder. At publish, the intent crosses the socket and
#    the BROKER terminal shows the ground-truth diff + resolved target + sha.
docker compose -f .devcontainer/docker-compose.yml exec coder \
  bash -lc 'cd harness && npm run orchestrate -- "add a --version flag to the CLI"'
```

`y` のとき、broker は fetch し、再検証し、承認された sha を構築された URL へ push し、PR を開く。
harness は PR の URL を表示する。`y` 以外のとき(または再検証時の不一致のとき)は、何も push されない。

再ビルドせずにベイク済みポリシーを上書きするには、**workspace の外**のホストファイルをそのパスに
bind マウントする(`/workspaces` を指してはならない、さもないと broker が fail-close する):

```yaml
  broker:
    volumes:
      - /etc/mrw-broker/policy.json:/etc/mrw-broker/policy.json:ro   # host path OUTSIDE the repo
```

## ホストプロセスによる代替(副次的)

broker を素のホストプロセスとして動かすのは、socket が境界を越える場合(Linux ホスト、または
あなたの環境で機能する bind)に最もシンプルだ。すでに git ホストネットワークと、シェル内の
トークンを持っている:

```bash
cd broker && npm install
BROKER_GITHUB_TOKEN=ghs_xxx \
BROKER_POLICY_FILE="$HOME/.config/mrw-broker/policy.json" \
BROKER_WORKTREES_DIR="$PWD/../tasks/TICKET-123/repositories" \
  npm start
```

`BROKER_POLICY_FILE` は workspace の**外**(例: `~/.config/mrw-broker/`)に置き、broker の socket
ディレクトリを coder に bind マウントする。信頼境界は同一だ: coder は型付き socket 経由でのみ broker に
到達し、外に出るのは人間が承認し git で検証された diff を構築された URL へ push したものだけ。

## 失敗コード(broker → harness)

`invalid_request`、`config_missing`、`repo_not_allowed`、`worktree_missing`、
`untrusted_config`、`detached_head`、`branch_mismatch`、`branch_not_allowed`、
`dirty_worktree`、`remote_unparseable`、`host_not_allowed`、`org_not_allowed`、
`fetch_failed`、`render_incomplete`、`nothing_to_publish`、`declined`、`canceled`、
`sha_changed`、`push_failed`、`pr_failed`、`busy`。どれも fail-closed だ: デフォルトの結末は
**未 publish**。ok でないレスポンスは `harness/src/publish.ts` を throw させ、orchestrator が
それを `exit 1` に変える。

## Phase 2 が変えるもの・変え**ない**もの

**変える:** coder の**外**の実際の publish 経路。sha で git オブジェクトから描画された ground truth に
人間ゲートを課す。push 先を、信頼されたプロセス内 allowlist と broker が構築した URL にロックする。
トークンをすべての coder config から隔離する。

**変えない:** coder にトークン・push 能力・GitHub egress を与えること
(`scripts/egress-selfcheck.sh` は依然としてパスする)。TLS を終端したり、人間の diff レビューを超えて
PR 内容を検査すること。secrets ストアを提供すること — トークンはあなたの環境 / secrets マネージャから
注入し、決してコミットしないこと。
