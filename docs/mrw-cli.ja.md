# `mrw` CLI — ツールを状態から切り離す(設計メモ)

**Status: Phase 1–2 は実装済み(`plan.md` 参照)。本稿は当初の設計記録です。** [architecture.md](architecture.md)
(セキュリティ層)と [agent-orchestration.md](agent-orchestration.md)
(コンテナ制御プレーン)の姉妹編。このメモは `muti-repo-workspace` が
ワークスペースそのもの*であること*をやめ、指し示したワークスペースディレクトリに
対して操作する **`mrw` バイナリ**になる道筋を定める — セキュリティ不変条件は
1つも手放さずに。

> 🇬🇧 English: [mrw-cli.md](mrw-cli.md)

## 動機

今のチェックアウトは同時に2つのものだ:

- **ツール** — skills、`harness/`、`broker/`、`reviewer/`、`templates/`、
  `.devcontainer/`、`scripts/`。
- **生成された状態の入れ物** — `repositories/`(worktree の origin)と
  `tasks/`(チケットごとの worktree)。どちらも gitignore 対象。

何をするにも、まずチェックアウトへ `cd` して `claude` を起動する必要がある。
状態とツールが1つのディレクトリと1つのライフサイクルを共有している。この結合が
3つの点で不便を生む: 複数の独立したワークスペース(異なるリポジトリの組み合わせ)を
並べて持てない。ツールをアップグレードすると同じツリー内のローカル生成状態との
整合が必要になる。そして「コンソール」は cwd が*そのままツールである* Claude
セッションなので、ツールを一度インストールして使い回すことができない。

**目標:** ツールは一度だけインストールする。`repositories/` と `tasks/` に相当する
状態は自分で選んだディレクトリに置く。ライフサイクルは小さな決定的 CLI で駆動する。
賢さは今と同じ場所(タスクごとの Claude セッション)にとどまる — CLI は dumb
authority であり、手続きを実行するだけだ。

## 目標 UX

```
# 導入時に一度だけ
mrw config                 # ワークスペースを初期化: ディレクトリを選び、リポジトリを登録

# 一日の始め、起動後
mrw infra-up               # このワークスペース用にコンテナスタックを立ち上げる

# タスクの開始時
mrw task-up https://…      # 1チケット分の worktree + cmux タブを作成
                           #   最後に BOUNDED な Claude SDK ステップで
                           #   チケットをトリアージ(type / title / repos)、
                           #   型付き出力のみ

# 新しい cmux ターミナルワークスペースへ移動
# → 対話形式の Claude セッション(plan / worker / review / publish)、今まで通り
```

これは今日の skill フロー(`/setup-workspace`、`/open-task` など)そのものに、
2つの変更を加えたものだ: 決定的な手続きが「skill markdown を Claude が実行する」
方式から本物のサブコマンドになる。読み書きする状態はツールのチェックアウトの
外に住むようになる。

## バイナリに移るもの、Claude に残るもの

| 対象 | 置き場所 | 理由 |
|---|---|---|
| config / infra-up / task-up / close / list / doctor | **`mrw` バイナリ(決定的コード)** | すでに「dumb authority」。skill markdown → 本物のコードは*緩くなる*のではなく*厳しくなる*: 不変条件が仮定ではなく assert されるようになる。 |
| `task-up` 内のチケットトリアージ | **bounded な Claude SDK leaf** | 読み取り専用、分類のみ、型付き出力 `{work_type, title, repos, summary}` — harness の `runPlan`/`runReview` と同じ形。賢さは型によって囲い込まれる。 |
| plan / implement / review / 人間との対話 | **タスクごとの Claude セッション** | 判断 + 対話。`task-up` の後 cmux タブで開かれる、今まで通り。 |

この分割は既存の哲学(「authority はケージの外にあり、authority は dumb」)を
*強化する*: skill markdown に散らばっていた決定ロジックが、下記のパス符号化された
不変条件を機械的に強制できる1つのコードパスに収束する。

## ワークスペースと config のモデル

Git 方式のディスカバリ。`mrw` は cwd から上へ辿って `.mrw/config.json` を探す。
`mrw config` がそれを作成する。

```
~/my-workspace/            # 自分で選んだ任意のディレクトリ。ここで `mrw config` を実行する
  .mrw/config.json         # workspaceRoot、repos[]、stack の name/id
  repositories/            # worktree の origin(デフォルト: ここ。config で上書き可)
  tasks/                   # チケットごとの worktree
```

`.mrw/config.json` は今日の `config/workspace.json` + `config/repos.json` を
吸収する(フィールドは同じ: `allowed_push_orgs`/`_hosts`、`default_purpose`、
`ticket_source`、`ticket_id_pattern`、`branch_prefix`、`repositories[]`)。
加えて:

- `workspaceRoot` — `repositories/`/`tasks/` を保持する絶対パス(デフォルト:
  `.mrw/` を含むディレクトリ)。
- `stack` — `workspaceRoot` から導出される compose プロジェクト名。これにより
  **複数のワークスペースがそれぞれ自分のスタックを並行して動かせる**
  (グローバルな `~/.config` ではこれはできない)。

ツールのアセット(`harness/`、`scripts/`、`docker/`、`.devcontainer/`、
`templates/`、`broker`/`reviewer` のイメージ定義)は**バイナリ自身のインストール
パス**(`toolHome`)から解決され、ワークスペースからは決して解決されない。状態と
ツールはこれで2つの独立したソースになる — が、素朴な分割が隠している3つの
複雑な点がある:

- **`broker-policy.json` は権威あるワークスペース単位の状態である。** broker は
  push 先 org/host の allowlist をプロセス内で強制する(pre-push フックはゲートではなく
  defence-in-depth)。このファイルはイメージへ焼き込まず、`mrw infra-up` が
  `MRW_CONFIG_DIR` で選ばれた config ディレクトリを read-only bind するため、同じ
  ツールインストールを共有するワークスペース同士でも安全に異なる設定を持てる。
- **`config/purposes/*.json`**(`dev.json`/`task.json`: `default_repos`、
  `mcp_servers`、`dev_kinds`。`open-task` が読む)はディレクトリ*まるごと*の
  config であり、*タスクプロファイル*(タスクがどのリポジトリ + MCP サーバーを
  開くか)である。その名前はそのまま OTEL の `purpose=` ラベルにもなる。
  **決定:** これは `toolHome` のデフォルトのままとし、ワークスペースごとの
  上書きは当面行わない(見送り — profiles は優先事項ではなく、OTEL ラベルは
  すでにプロファイル名から流れてきているため)。ワークスペースが独自の
  profiles を必要とするようになったら再検討する。
- **`WORKSPACE_ROOT` は今日1つの多重化された変数だ**: `scripts/` と orchestrator
  の `denyWrite` テンプレートは、ツールのアセット(`.githooks`、`scripts`、
  `templates`、`.claude`)と状態(`config`、`repositories`、`tasks`)の*両方*に
  対して単一の `{{WORKSPACE_ROOT}}` トークンを使っている。この分割の本当の作業は、
  **すべてのスクリプトとテンプレートにわたってこの1つのトークンを `toolHome` と
  `workspaceRoot` に分岐させること**であり、下記に挙げる3つの不変条件だけでは
  ない。

## 本質的な compose の変更

`.devcontainer/docker-compose.yml` は `..`(リポジトリルート)からの相対パスで
すべてを固定のコンテナパス `/workspaces/muti-repo-workspace` にバインドしている。
コンテナ内側のレイアウトは固定のままでよい。変わるのは**ホスト側**だけであり、
それは2つのソースに分かれる:

| コンテナパス | 今(ホスト) | 目標(ホスト) | アクセス |
|---|---|---|---|
| `…/tasks` | `../tasks` | `${workspaceRoot}/tasks` | rw(worker) |
| `…/repositories` | `../repositories` | `${workspaceRoot}/repositories` | :ro |
| `…/harness`、`…/scripts` | `../harness`、`../scripts` | `${toolHome}/harness`、`${toolHome}/scripts` | :ro |
| `…` 全体(**orchestrator + broker** :ro) | `..` | **合成**{`${toolHome}` ∪ `${workspaceRoot}` の状態} :ro | :ro |

最後の行が微妙なところだ: **orchestrator と broker** は現在、リポジトリ*全体*
(`..`)を1つの事実として読み取り専用マウントしている。外部化はこの単一の
マウントを tool-assets-ro + state-ro に分割する。(**reviewer についてはここで
compose の変更が一切不要**——そもそもワークスペースのマウントを持たない。実行
するものはすべてイメージに焼き込まれており、見えるのは自分のソケットと
`review-diffs:ro` だけだ。)`mrw infra-up` が config から絶対パスで compose
(または compose + override)を**生成する**。手作業で保守する相対パスの compose
は不要になる。~~`BROKER_WORKTREES_DIR` は `mrw` がタスクごとに
`${workspaceRoot}/tasks/<T>/repositories` に固定する。~~
**廃止（2026-07-17）**: このタスクごとの env 固定は
docs/broker-ticket-routing.md の案 (b) にあたり、同メモで却下された
（多重度が 1 のままで、向け替えのたびに他チケットの承認待ちが飛ぶ）。
代わりにリクエスト搭載 ticket ルーティング + オペレーター登録制レジストリを
実装済み — per-ticket publish に `BROKER_WORKTREES_DIR` の上書きは不要
（この env は legacy/ticket なしリクエストのフォールバックとして残る）。

生成器が書き換えなければならないホスト相対のものがもう2つある。`volumes:`
バインドではないため見落としやすい:

- **`build.context`。** すべてのサービスは `context: ..` からビルドされる
  (egress-proxy は `../docker/egress` から)。これらの Dockerfile は
  `toolHome` のアセットなので、生成される compose は `build.context` を
  ワークスペースではなく `${toolHome}` に向ける。
- **名前付きボリュームの状態は、ホストのファイルシステム上にすら存在しない
  *第三の*場所だ。** `spine-notes`(orchestrator の `MRW_STATE_DIR` 不変条件
  台帳)と `review-diffs` は、compose プロジェクトにスコープされた Docker
  管理の名前付きボリュームである。これらは `toolHome` でも `workspaceRoot`
  配下のファイルでもないため、「状態とツールは2つのソース」は実際には
  *3つ*だ。**決定:** これらは運用上の*履歴*(不変条件台帳、レビュー済みの
  diff)を保持しているため、デフォルトでは**保持する**。`mrw close --purge`
  で明示的に破棄する。安全な経路で履歴を自動削除することは決してない。

## `task-up` の bounded なトリアージステップ

決定的な作業(worktree add、テンプレートレンダリング、cmux タブ)の後、`mrw
task-up` は取得したチケットのテキストに対して**読み取り専用・型付き**の Claude
SDK クエリを1回実行し、次を返す:

```
{ work_type: string, title: string, repos: string[], summary: string }
```

ここが `work_type` の本来の置き場所だ。OTEL テレメトリ作業
(devcontainer-status の項目10)はこれを意図的に固定値 `feature`/`auto` の
ままにしていた。`task-up` はこれを一度だけ導出し、チケットのコンテナ用に
`MRW_WORK_TYPE` を設定できる。そこから既存の self-derivation 機構
(`harness/src/telemetry.ts`)がそれを `OTEL_RESOURCE_ATTRIBUTES` へ運ぶ。

**このステップが動かす信頼境界について正直に言う。** 今日、`work_type` は
*もっぱら*運用者が設定する `MRW_WORK_TYPE` に由来する——チケットやリクエストの
内容からは明示的に決して来ない、「だからコーダーが自分の `work_type` を選ぶ
ことはできない」という設計だ。取得したチケットのテキストを読む分類器から
これを導出するということは、この値が今後チケットの内容の影響を受けるという
ことであり、`ticket_source: github-issues` の場合それは外部から供給された
ものである。これが許容できるのは**次の場合に限る**: (a) `work_type` は
テレメトリの*ラベル*であり fail-open で、「偽のデータ」は `mrw-telemetry`
ネットワークにおいて既に許容されているリスクである。(b) 分類器の出力は
**検証済みの語彙**(自由形式ではなく enum/regex)に制約されており、属性の
構文を注入できない。(c) それはケージの外、運用者が実行する `task-up` に
よって**ホスト側で**設定される——ケージ内のコーダーは依然としてそれを選べ
ない。これは決して権威あるもの(push 先、ポリシー)にまで拡張しては
ならない——それらは引き続き運用者/`broker-policy` の所有物のままである。
このステップ自体は bounded な tool-less leaf である: 全 built-in tool を deny し、
`settingSources: []`、不活性な cwd、構造化出力を使う。編集は一切せず、publish
するものを選ぶこともしない。

## 移行時のハザード(黙って劣化させてはならない)

1. **Compose の絶対パス化**(上記) — 最もボリュームのある機械的変更。
   `mrw infra-up` が config から compose を生成することの眼目そのもの。
2. **pre-push フックは自分の config をパスから自己特定している — この分割で
   二重に壊れる。** `.githooks/pre-push` は自分の config を
   `$(dirname $(dirname $0))/config/workspace.json` として導出する——
   `.githooks` がインストールされている場所から上へ辿るやり方で、ファイル名は
   ハードコードされている。この分割はこれを2通りに壊す: (a) `.githooks` が
   `toolHome` のアセットである一方 config が `workspaceRoot` の下に住むなら、
   dirname を辿るやり方は*間違ったツリー*に解決されてしまう。(b) ファイル名
   自体が変わる(`config/workspace.json` → `.mrw/config.json`)。フックは
   自分のインストールディレクトリから上へ辿るのではなく、config の場所を
   (環境変数か生成されたパスで)明示的に教えられなければならない。これは
   当初想定していた3つの「パスに符号化された不変条件」よりも具体的な
   ハザードである。
3. **`WORKSPACE_ROOT` の分岐**(上記の config モデルの複雑な点を参照):
   `scripts/` のすべての参照と、すべての `{{WORKSPACE_ROOT}}` テンプレート
   トークンを `toolHome` と `workspaceRoot` に分割しなければならない。
   orchestrator の `denyWrite` リストが最も鋭いエッジだ — 現在は
   `.githooks`/`scripts`/`templates`/`.claude`(ツールのアセット)*と*
   `config`(状態)を1つのトークンの下に列挙している。
4. **worktree 作成のルール。** CLAUDE.md のルール(「相対ターゲット、コマンド
   連結禁止」)は Claude がコマンドを実行していたから存在する。`mrw` は
   `git -C <origin> worktree add <computed-path> …` としてコードの中でそれを
   実行する。ルールは prompt 時点のハザードではなく、1つの関数の実装詳細になる。

新たに脆くなる*わけではない*点についての補足: orchestrator の
`excludedCommands` ↔ `CLAUDE.md` のバイト単位一致は**すでに構成上保証されて
いる**——`scripts/lib/common.sh` の `render_template()` が1つの共有パス値を
1回のパスで両方のファイルに代入するので、(ホーム相対でも絶対でも)どんな
パスであっても分割後も一貫性が保たれる。`mrw doctor`(マウント監査、egress
のセルフチェック、ハザード2向けの config discovery チェック、ハザード3向けの
`denyWrite` 分岐チェック)はそれでも持つ価値があるが、バイト一致はそれが
救うべきものではない。

## Thread B — ブラウザ承認(独立、別途出荷)

**Status: BUILT** — [browser-approval.ja.md](browser-approval.ja.md) を参照。

ユーザーのスケッチ(ステップ5–6)は、承認をブラウザへ移す案を示している: diff
summary、review 結果、full diff、そして approve。これはレンダリングの良い
アップグレードだが、この設計全体の中で**唯一の権威あるゲート**に触れるので:

- **承認行為として SHA タイプを維持する。** broker の short-SHA ゲートが唯一の
  権威ある人間ゲートであり、SHA をタイプすることが*人間がその特定のコミットを
  見たことを証明する*。ワンクリックボタンはこれを1ビットの同意に劣化させる。
  ページは diff summary / 助言的な reviewer verdict / full diff を美しく描画して
  よいが、承認には依然としてページへの short SHA のタイプ入力が必要である。
- **承認サーバーを攻撃対象として扱う。** push を承認できるローカル HTTP
  エンドポイントは**localhost バインド + セッションごとのトークン / CSRF 対策**
  必須。さもないとローカルの任意プロセスや drive-by ページが承認を POST
  できてしまう。broker は LLM フリーのままであり、reviewer の verdict は助言的な
  テキストとしてのみ描画される。
- **リスナーは broker ではなく独立した `mrw serve` に住む(決定済み)。**
  今日、broker はホストポートを一切公開していない——UNIX ソケットと
  `approve.ts` 用の TTY readline があるだけだ。broker はまた
  `BROKER_GITHUB_TOKEN` の唯一の保持者であり、本物のインターネット egress を
  持つ唯一のケージでもある。そのコンテナ分割はまさにこのトークンを隔離する
  ために存在する。HTTP リスナーを broker の*内部*に置くとトークン保持者の
  攻撃対象領域が広がってしまう。そこで代わりに、**トークンを持たない**独立した
  `mrw serve` プロセスがページを描画し、既存のソケット越しに承認を broker へ
  中継する。重要なのは broker が **`mrw serve` を信頼しない**ことだ:
  push の前に、タイプされた short SHA を保留中の publish に対して独自に
  再検証する。これにより権威あるゲートはトークン保持者の内部にとどまり、
  `mrw serve` が侵害されても単独では push できない。

  ```
  browser ──HTTP(localhost+token)──▶ [ mrw serve ]  (トークンなし、push 不可)
                                          │ UNIX socket
                                          ▼
                                     [ broker ]  (トークンあり、SHA 再検証、push) ──▶ GitHub
  ```

これは Thread A と直交しており、その前後どちらでも取り込める。

## フェーズ分け

1. **状態を外部化し、skill はそのまま**(*有用な*最小の一歩だが、決して小さくは
   ない): `WORKSPACE_ROOT` を `toolHome`/`workspaceRoot` にスクリプトと
   テンプレート全体で分岐させ、config から compose を生成し、
   `broker-policy.json` を実行時マウントへ移し、pre-push フックに自分の
   config パスを教える——バイナリは*まだ*作らない。ここで compose + 不変条件の
   作業が単独で検証される。リスクの大部分はここにある。
2. **`mrw` バイナリ**が(パスがクリーンになった)手続きをサブコマンドとして
   ラップする。skill は薄いシムになるか廃止される。
3. **`task-up` のトリアージ leaf** — bounded な分類器を配線する。固定の
   `work_type` を廃止する。
4. **ブラウザ承認**(Thread B) — 独立。

## 変わらない不変条件

Egress allowlist(Squid)と `mrw-telemetry` 内部ネットワーク。5-role 封じ込め
モデルと role ごとのサンドボックス。broker は LLM フリーで、SHA ゲートが唯一の
権威ある承認。worker は broker ソケットを決して保持しない。
`allowed_push_orgs`/`_hosts` は(`broker-policy.json` 経由で、今やワークスペース
ごとに)**broker がプロセス内で**強制し、pre-push フックは defence-in-depth
として働く。このメモが移すのは*状態がどこに住むか*と*誰が手続きを実行するか*
であり、何が封じ込められているかは変わらない。
