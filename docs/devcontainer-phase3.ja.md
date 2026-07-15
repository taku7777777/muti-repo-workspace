# Phase 3 — マルチ repo ドライバ(1チケット、N repo、repo 横断ゲート)

Phase 0 は coder を caged にした(ネットワーク境界、push 認証情報なし、GitHub egress なし)。
Phase 1 は repo ごとに決定的な `plan→implement→review⇄fix→test→approve` パイプラインを
与えた。Phase 2 は publish のスタブを、コンテナ外・人間ゲート付きの broker で置き換えた。
Phase 3 は **1チケットが N repo にまたがる**ことを可能にする: repo ごとの coder パイプ
ラインを逐次的に駆動し、**repo 横断の人間ゲート**、再開可能な進捗、正直な部分失敗の
ストーリーを備える。

これは **caged な coder コンテナの中**で走る。repo ごとのチェックアウトは**ローカル
クローン**(ネットワークなし)であり、publish は依然として Phase 2 の broker を**通じてのみ**
行われる。新たな egress なし、トークンなし、Phase 0〜2 の封じ込めの弱体化なし。

> 🇬🇧 English: [devcontainer-phase3.md](devcontainer-phase3.md)

## 何が変わったか

### 1. `runOrchestrator` — Phase 1 の状態機械、再利用可能に

`harness/src/orchestrator.ts` はもはやスクリプト*ではない*。状態機械を **export** する:

```ts
runOrchestrator(opts: {
  instruction: string;
  repoDir: string;            // the worktree this pipeline operates on
  label?: string;             // repo name in logs
  plan?: Plan;                // skip the internal PLAN step (driver pre-planned)
  approvePlan?: (plan, ctx) => Promise<boolean>;      // delegable gate
  approvePublish?: (info: PrePublishInfo) => Promise<boolean>; // delegable gate
}): Promise<OrchestratorResult>
```

```ts
type OrchestratorResult = {
  outcome: "published" | "declined" | "not_ready" | "failed";
  sha?: string; prUrl?: string | null; reason?: string;
};
```

これは **`process.exit` を決して呼ばず**、型付きの結果を返す。**Phase 1 のすべての
ゲートと fail-closed の挙動はそっくりそのまま保持されている:**

- approve-plan(人間) — いまや*委譲可能*で、ドライバが1つの結合ゲートにまとめられる。
  省略すると同一の対話式 `y/N` プロンプトになる。
- IMPLEMENT → REVIEW(読み取り専用)+ TEST-GATE、**上限付き**の fix ループ付き
  (`MAX_FIX_ATTEMPTS`、使い切ると fail-closed)。
- **incomplete-diff ハードストップ** — 完全に計算できなかった diff は決して
  レビュー/承認されず、`failed` を返す。
- **test-gate の終了コード真理** — `testGate(repoDir)` は `status === 0` のみで分岐する。
  モデルが pass/fail を自己申告することはない。
- approve-publish(人間) — harness が計算した diff を表示し、変更が
  test/テストコマンドに触れていれば別途 **test-independence** の ack を要求し、
  最後に `Publish?` を出す。このゲートは*委譲可能*だが、ドライバはそれを**ラップ**する
  (結合サマリを前置きする)うえで**同じ組み込みゲートに委ねる**ので、diff 表示と
  注意書きが失われることはない。
- PUBLISH は Phase 2 の broker 経由 — broker のコンテナ外・人間ゲートが**権威ある**
  ゲートのまま。broker が拒否すると throw → `failed`。

**薄いシングル repo CLI** も残る: `npm run orchestrate -- "<instruction>"` は
`REPO_DIR`(または cwd)に対して `runOrchestrator` を呼び、outcome を終了コードに
マップする(`failed`→1、それ以外は 0)。モジュールを import しても(ドライバから)
CLI は**起動しない** — プロセスのエントリポイントであるときだけ走る。

いまや各ステップが明示的な `repoDir` を取る(`steps.ts`・`gates.ts`・`publish.ts` を
SDK の `cwd` / `git -C` のターゲットとして貫通させている)ので、ドライバは N repo を
**1プロセス**で走らせられる — 旧来のモジュールレベル `CWD` では全 repo が同じ
ディレクトリに固定されていた。

### 2. `harness/src/multi/*` — ドライバ

| ファイル | 役割 |
|---|---|
| `multi/driver.ts` | CLI + `runDriver`: repo の解決、worktree のセットアップ、結合 plan ゲート、repo ごとの逐次 `runOrchestrator`、結合 pre-publish サマリ、正直な報告、再開可能性。 |
| `multi/worktree.ts` | `setupWorktree`: `git clone --reference <origin> --dissociate`(ローカル、ネットワークなし)で `tasks/<ticket>/repositories/<repo>` にブランチ `<branch_prefix><ticket>` として展開。`type:'knowledge'` ⇒ `--no-checkout` + `sparse_paths[purpose]` からの cone sparse-checkout。broker のために `origin` を実際の upstream url に向ける。git はすべて `spawnSync` の argv 配列経由。 |
| `multi/config.ts` | ワークスペースルートの解決。`config/repos.json` と `config/workspace.json` のロード + 検証。`selectRepos`(`--repos` によるサブセット、未知の名前はハードエラー)。 |
| `multi/state.ts` | チケット状態ファイルをアトミックにロード/セーブ(temp + rename)。 |
| `multi/types.ts` | config ファイルとチケット状態の Zod コントラクト。 |

## repo 横断ゲート

repo は**逐次的に**走る。ドライバは2つの結合ビューを表に出す:

- **結合 plan ビュー。** いかなる実装の前にも、ドライバは未 publish の全 repo に対して
  **読み取り専用**の PLAN ステップを走らせ、それらをまとめて表示し、**1つ**の結合
  approve-plan ゲートを取る。その単一の承認が repo 横断の plan ゲートである。以後、
  各 repo の `runOrchestrator` は事前計算された plan と `approvePlan: () => true` で
  走る(二重ゲートなし、再 plan なし)。
- **結合 pre-publish サマリ。** 各 repo の publish ゲートの直前に、ドライバは完全な
  台帳(どの repo が既に publish 済みか — sha 付き — どれがいま publish 中か、どれが
  保留か)を表示し、その後で組み込みの publish ゲート(diff + 注意書き + 確認)と
  broker の権威あるゲートに委ねる。

## アトミック性 — 正直な部分

**N 個の GitHub repo をまたぐ真のアトミック性は不可能である。** publish は逐次的で、
各 push は独立している。repo *k* がいったん push されればそれは**公開済み**であり、
後で repo *k+1* が失敗してもロールバックされない。ドライバはそれをごまかさない:

- 途中で `published` 以外の outcome が出たら**停止**し、残りの repo には**触れない**。
- どの repo が **published** されたか(sha/PR 付き)、どれが **stopped/failed** か
  (理由付き)、どれが **not attempted** かを正確に列挙したレポートを表示する。
  黙った部分成功はない。
- 終了コード: 全 publish 済み ⇒ 0。人間による decline ⇒ 0(クリーンな停止、部分
  レポート)。いずれかの fail-closed / not-ready ⇒ 1。

## 再開可能性

repo ごとの進捗は、各 repo の後に `tasks/<ticket>/phase3-state.json` に永続化される
(publish がチェックポイント)。再実行では:

- 記録された outcome が `published` の repo を**スキップ**し、
- それ以外はすべて再 plan + 再実行する。

こうして、途中の失敗を直してチケットを再駆動できる — 最初の未 publish repo から
再開する。書き込みはアトミック(temp ファイル + `rename`)。壊れた状態ファイルは
無視され(決して信用しない)、チケットは単純に再 plan する。

> Note: **スタブモード**(`BROKER_SOCKET` 未設定)では何も push されないが、フローは
> `published` として完了する(reason にスタブの旨を記す)。すると再実行はその repo を
> スキップする。これは開発専用の便宜であり、broker が配線されていれば `published` は
> 実際の、人間が承認し git 検証された push を意味する。

## 実行方法

```bash
# Inside the caged coder container, from the harness dir.
# All selected repos from config/repos.json:
npm run drive -- --ticket ABC-1 "add a --version flag and document it"

# A subset, in this order, with an explicit sparse-checkout purpose:
npm run drive -- --ticket ABC-1 --repos example-app,example-knowledge --purpose task \
  "add a --version flag and document it in the knowledge base"
```

フラグ: `--ticket <id>`(必須。`ticket_id_pattern` で検証)、
`--repos <csv>`(任意のサブセット、順序保持)、`--purpose <name>`
(任意。デフォルトは `default_purpose`)。それ以外はすべて instruction。

ブランチは各 repo で `<branch_prefix><ticket>`(例: `feat/ABC-1`)。worktree は
`tasks/<ticket>/repositories/<repo>` に置かれる。publish は Phase 2 とまったく同じく
Phase 2 の broker を使う — coder に `BROKER_SOCKET` を設定し broker を走らせる
(`docs/devcontainer-phase2.md` を参照)。未設定 ⇒ スタブ(push なし)。

## 設定

| Env | デフォルト | 意味 |
|---|---|---|
| `MRW_WORKSPACE_ROOT` | モジュールから解決(`…/harness/src/multi` → 3階層上) | `config/`・`repositories/`・`tasks/` を含むワークスペースルート。 |
| `REPO_DIR` | cwd | シングル repo CLI のターゲット専用(`npm run orchestrate`)。ドライバは各 repo の dir を自分で設定する。 |
| `BROKER_SOCKET` | *(未設定 ⇒ スタブ)* | Phase 2 と同じ — publish ソケット。 |
| `TEST_COMMAND` | `npm test` | オペレータが固定する test-gate コマンド。repo worktree ごとに実行。 |
| `MAX_FIX_ATTEMPTS` | `3` | 各 repo の fix ループの上限。 |
| `HARNESS_MODEL` | `sonnet` | 全ステップのモデルエイリアス。 |

ドライバは `config/workspace.json` から `branch_prefix`・`default_purpose`・
`ticket_id_pattern` を、`config/repos.json` から repo リスト(`name`・`url`・`type`・
`sparse_paths`)を読む。

## Phase 3 が変えること・変え**ない**こと

**変える:** repo ごとの coder と repo 横断の人間ゲートを備えた、N repo をまたぐ
1チケット。結合 plan ゲートと結合 pre-publish サマリ。逐次的で broker ゲート付きの
publish。repo ごとの再開可能な状態。明示的で正直な部分失敗レポート。

**変えない:** coder にトークン・push 能力・GitHub egress を与えること(クローンは
ローカル、publish は依然として Phase 2 の broker のみを通る)。repo をまたぐ publish を
アトミックにすること(不可能 — 率直に述べ、停止 + 報告で対処する)。Phase 1 の
いずれかのゲートの判定ロジック、または broker の権威あるゲートを変えること。
