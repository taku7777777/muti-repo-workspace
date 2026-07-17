# broker の per-ticket ルーティング — リクエスト搭載 ticket + オペレーター登録制レジストリ（設計メモ）

**ステータス: 実装済み + ライブ検証済み 2026-07-17。** R2（broker 側）=
`dedaffd`、R3（送信側/レジストリ/配線）= `b621372`。R4 ライブ実走: チケット
RT-1（phase2-demo#5）と RT-2（phase3-docs#2）を、**間で再作成することなく同一
broker から** publish — オペレーターが export したのは `BROKER_GITHUB_TOKEN`
だけで、`BROKER_WORKTREES_DIR` の儀式は不要だった。ticket バッジは両方の承認
サーフェスに表示され、tests-touched caveat も両方で点灯（package.json ルール）。
負系レグ: socket プローブ 5 種（未登録 / 登録済み+repo 不在の順序検証 /
case-alias / legacy ヒント / 登録解除後）、および F6 レグ — ゲートが開いている
間に RT-1 を登録解除し、**正しい** sha で承認 → `push/PR failed: ticket 'RT-1'
is no longer registered; aborting`、何も push されず; 再登録 → 再申請 →
publish 成功。R4 で見つかった既知のフォローアップ（本メモのスコープ外）:
workerd はスタック単一・シングルフライトのため並行チケットのステップが競合し
（`workerd busy`）、しかも busy 拒否が worker-run 予算を消費する; `run_tests`
は `npm test` 前提のため package.json の無い docs リポジトリはゲートを通れない
（per-repo TEST_COMMAND は未対応）。
関連: docs/mrw-chat.md（Thread C）、docs/devcontainer-phase2.md（broker
契約）、docs/browser-approval.md（Thread B）。C4 ライブ E2E（チケット ETE-1 →
phase2-demo#4）で発見。

## 動機

broker は検証・push の対象となる git ツリーを `BROKER_WORKTREES_DIR` という
**コンテナ起動時に固定される** env で特定する。legacy スタック
（`scripts/devcontainer-up.sh`）はこれを汎用の `<ws>/repositories`（origin
クローン、常に `master`）に向けて起動するが、各チケットの実作業は
`<ws>/tasks/<T>/repositories/<repo>` の `feat/<T>` 上にある。過去の publish
（Phase 2/3、DEMO-6）がすべて成功していたのは、オペレーターが `up` の前に手で
`BROKER_WORKTREES_DIR=tasks/<T>/repositories` を export していたから — どの
ランチャーにも配線されたことのない「儀式」だった。Thread C が per-ticket
セッションをセルフサービス化（`mrw chat <T>`）したことでこの儀式がついに
省かれ、C4 E2E が実機で踏んだ: `request_publish` が tests と review の通過
**後に** `branch_mismatch`（"request branch 'feat/ETE-1' != worktree branch
'master'"）で失敗 — 真因は「broker が別のツリーを見ている」なのに、遅く・
誤解を招くエラーになる。

他のすべての層は既に per-ticket 化されている（worktree、spined + そのロック、
`/var/mrw/notes/<T>` の ledger、telemetry ラベル）。broker の worktree 固定
だけが多重度 1 に取り残された層であり、しかも手動だった:

| 層 | per-ticket | 多重度 |
|---|---|---|
| worktree（`tasks/<T>/`） | yes | N |
| chat / spined（チケットごとのデーモン + ロック） | yes | N |
| ledger（`MRW_STATE_DIR/<T>`） | yes | N |
| telemetry（`workspace=<T>`） | yes | N |
| **broker の worktree 参照** | **no — 起動時 env、手動** | **1** |

手動固定の運用コスト（実機で観測）: 失敗が最後に出てブランチの問題に読める;
向け替えには push token をそのシェルに再 export した上での
`--force-recreate` が必要; 再作成すると他チケットの承認待ちが飛ぶ。

## 決定

**リクエスト搭載 ticket ルーティング + オペレーター登録制チケットレジストリ**
（2026-07-17 の議論での「c+」案）を採用する:

1. publish リクエストに **optional な `ticket` フィールド**を追加。存在する
   場合、broker は worktree を `<BROKER_WORKTREES_DIR>/<repo>` ではなく
   `<BROKER_TASKS_DIR>/<ticket>/repositories/<repo>` で解決する。
2. ticket の主張は**登録済みの場合のみ**受理: ホスト側（信頼される側）の
   スクリプトがタスク/チャット作成時に登録し、close 時に登録解除する。その
   ディレクトリは broker（ro）とホスト（rw）だけが見える。未登録チケットは
   fail-closed（`ticket_not_registered`）。
3. `ticket` フィールドなし ⇒ **挙動同一の legacy 経路**（env 固定の
   `BROKER_WORKTREES_DIR`; 診断は改善 — failure codes 参照）。手動固定は
   引き続き機能する。

検討して却下した代替案:
- **(a) 早期の明示エラーのみ** — 診断は良くなるが、手動再作成の儀式（と
  token/承認待ち消失のリスク）が残る。（エラー明確化の価値はこの設計に吸収
  済み: failure codes 参照。）
- **(b) `mrw` がチケットごとに broker を再固定** — 儀式は自動化されるが
  publish の多重度は 1 のままで、2 チケットが交錯するたびに「再作成が他
  チケットの承認待ちを飛ばす」リスクをむしろ*確定*させる。
- **(d) チケットごとの broker インスタンス** — 分離としては最もきれいだが、
  compose ジェネレーター（docs/mrw-cli.md の Thread A 残件）が必要で、今日の
  問題には過大。将来の選択肢としては排除しない。

## 信頼モデルの変化（最初に読むこと）

今日、「broker がどのツリーを検証するか」は**オペレーターが主張する事実**
（人間が起動した瞬間に設定される broker 自身の env）である。この設計はそれを
**オペレーターの事実によって制約された、cage からの主張**に変える:

- broker は、決定論的な spine コードが送ったリクエストと、orchestrator
  コンテナ内で侵害されたプロセスが偽造したリクエストを区別できない。socket に
  届くものはすべて主張である。これは変わらない。
- 主張が選べるのは、**等しく coder-writable な `tasks/<T>/repositories`
  ツリーのうちどれを検証させるか**だけ — しかも**オペレーターが実際に開いた**
  チケットの中からだけ（レジストリはホスト側スクリプトのみが書く; どの cage
  にも rw マウントは存在しない）。
- 下流のゲートはすべて不変: broker 自身の policy による
  allowed_push_hosts/orgs、branch チェック、git オブジェクトから描画される
  ground-truth diff、人間の SHA 打鍵承認、broker 内の token 隔離。

受容する残余リスク: T1 の orchestrator が侵害された場合、登録済みチケット T2
のツリーの publish を申請できる。ゲートに表示される diff・branch
（`feat/T2`）・ticket バッジはすべて正直に T2 のものなので、承認する人間は
自分が来た会話との不一致に気づける — 人間ゲートで抑えられる confused-deputy
リスクであり、既存の「人間が diff を読む」依存と同じクラス。緩和策: **両方の
承認サーフェス**が ticket を目立つ位置に表示すること。`mrw serve` ページは
meta 行に `ticket:` バッジを既に描画する（固定位置 — title/body は下のパネル
に描画され、画面外に押し出せない）; TTY ゲートの `renderHeader`
（broker/src/approve.ts）は当時 ticket 行を描画していなかった — **R2 で
追加**; 緩和策は両サーフェスに載って初めて実効する（レビュー指摘 1）。

## アーキテクチャ

### ワイヤ契約（broker/src/types.ts）

```ts
// PublishRequestSchema に追加（.strict() は維持）:
ticket: TICKET.optional(),
// TICKET = bare-name 形状。config.ts の SAFE_TICKET と同じ文字集合:
// /^[A-Za-z0-9._-]{1,100}$/、加えて BARE_REPO が既に持つ
// '.'/'..'/「'..' を含む」の refinement。broker はワークスペースの
// ^[A-Z]+- というチケット形式は強制しない — bare-name 安全性 +
// レジストリ所属のみ。
```

新しい failure code: `ticket_not_registered`（regex は妥当だがレジストリに
無い）。regex 不正な ticket はスキーマ経由で `invalid_request`。routed の
branch 束縛失敗（`actualBranch !== branch_prefix + ticket`）は
`branch_mismatch` を再利用し、3 つの値すべてをメッセージに含める。ハンドラの
順序: **レジストリチェックは worktree 存在チェックより先に走る** —
未登録のプローブがどの worktree が存在するかを列挙できないように（レビュー
指摘 6）。legacy の `branch_mismatch` メッセージは、リクエストの branch が
policy の `branch_prefix` で始まるのに env 固定の worktree がデフォルト
ブランチにいる場合、ヒントを付加する: "is this broker pointed at the right
worktrees dir? (BROKER_WORKTREES_DIR=<value>; per-ticket requests carry
`ticket`)" — 案 (a) の診断的価値の吸収。

**バージョンスキュー**（レビュー指摘 2）: broker はイメージ焼き込みで、
harness はコンテナ起動のたびに再コピーされる。古い broker + ticket を送る
harness の組み合わせは、routed publish がすべて `invalid_request` で失敗する
（`.strict()` が未知フィールドを拒否）— まさに本メモが直そうとしている
「遅く・誤解を招く」クラス。緩和策は両方必須: (i) harness 送信側は、ticket
搭載リクエストへの `invalid_request` 応答に対し、生のエラーではなく
「broker image predates ticket routing — run `mrw infra-up --build` (or
`docker compose build broker`)」を表面化する; (ii) R3 のロールアウト手順に
broker rebuild を明示的なオペレーター手順として記載する。

### チケットレジストリ

- **場所（ホスト）**: `<state_root>/broker-tickets/` — `tasks/` の兄弟、
  生成される状態、gitignore 対象。`tasks/` 配下（coder-writable）にも
  `config/` 配下（人間が編集する真実）にも置かない。
- **マウント**: broker に `/etc/mrw-broker/tickets/` として `:ro` バインド
  （**ディレクトリ**バインド — 2026-07-16 レビューで学んだ policy の単一
  ファイルバインドの stale-inode 教訓を初日から適用。ホストスクリプトは
  この中のファイルを作成/削除するので、ファイルバインドでは inode が固定
  され見逃す）。
- **エントリ**: チケットごとに 1 ファイル、ファイル名 = `<TICKET>`、内容は
  JSON `{ "ticket": "<T>", "created_at": "<iso8601>" }`（内容は情報提供のみ;
  存在が認可）。broker 側の所属チェック: パスに使う**前に** TICKET で検証し、
  次に**レジストリを `readdir` して厳密一致（`===`）を要求** — 素の
  `lstat(path)` ではない。macOS 由来の case-insensitive バインドでは
  `ETE-1` の登録で `ete-1` が通ってしまう（レビュー指摘 4; R2 に case-alias
  テスト必須）。一致したエントリは通常ファイルでなければならない
  （symlink/ディレクトリは拒否 — fail-closed）; 内容はどこにも追従しない。
- **F6 で所属を再チェック**（handler.ts の承認後再検証 — 既に config/target/
  sha を再チェックしている箇所）: ゲートが開いている間に登録解除された
  チケットは push してはならない（レビュー指摘 10）。
- **書き込み側**（すべてホスト側・信頼される側）: `scripts/create-workspace.sh`
  （task-up）と `scripts/chat-up.sh` が登録; `scripts/remove-workspace.sh`
  （close）が登録解除。`devcontainer-up.sh` の `mkdir -p` を含むすべての
  レジストリ書き込みは、パスに触れる前に Phase-2.2 のガード（存在する最長
  プレフィクスの `canonicalize`、`tasks/` パスセグメントの拒否）を適用する —
  symlink された、あるいは tasks 配下にネストされた `state_root` がレジストリ
  を coder-writable な空間に移動させられないように（レビュー指摘 3 — 同じ
  脆弱性クラス、chat-up.sh の `refuse_if_under_tasks_segment` と同じレシピ）。
- **ライフサイクル**: `mrw close` がタスク・チャット両チケットの唯一の登録
  解除ポイント（チャットチケットも `tasks/<T>` 配下にあり、同じ方法で
  close する）。登録解除はエントリ不在を許容する（機能導入前のタスク）。
  `mrw chat --resume` は冪等に再登録する — レジストリ導入**前**に開かれた
  チケットの救済経路（実装後レビューの指摘: spine-prepare が非 resume の
  再実行を拒否する以上、resume がそのようなチケットの唯一の再入口）。
  放置されたまま close されていないチャットチケットが routable であり続ける
  のは定義上正しい — レジストリが写像するのは「オペレーターが開き、まだ
  close していない」であり、それより狭い何かではない（レビュー指摘 5）。
  worktree が消えた stale エントリは後段で `worktree_missing` として落ちる —
  無害。
- **cage からの可視性**: worker は `tasks/`（rw）+ `repositories/`（ro）
  だけをマウントする — レジストリは見えない。orchestrator の全ワークスペース
  `:ro` マウントは legacy レイアウトでレジストリを*読める*かもしれないが、
  読めるのは開いているチケット名だけで無害; 書き込みは不可能。

### 解決（broker/src/handler.ts、config.ts）

- 新 env `BROKER_TASKS_DIR`、デフォルト `${BROKER_CODER_TREE}/tasks` —
  主張がその下で解決される**オペレーター主張のベース**。主張が選べるのは
  その中の `<ticket>` セグメントだけで、ベースは決して選べない。
- 新 env `BROKER_TICKETS_DIR`、デフォルト `/etc/mrw-broker/tickets` —
  レジストリマウントの着地点（レビュー指摘 9: テストは一時ディレクトリに
  向ける必要がある; ホスト実行の broker で未設定なら可視的に失敗すること）。
  ticket 搭載リクエストに対しレジストリディレクトリが読めない/不在なら、
  ディレクトリ名を含むメッセージ付きで `ticket_not_registered` として
  fail-closed。
- `ticket` あり: `wt = resolve(BROKER_TASKS_DIR, ticket, "repositories",
  repo)` に続けて、今日の `resolveWorktree` と同じ封じ込めチェック（解決
  済みパスが `BROKER_TASKS_DIR/<ticket>/repositories/` 配下に留まること）を、
  regex 検証済みのコンポーネントに対して行う。`ticket` なし: 今日と全く同じ
  `WORKTREES_ROOT` 配下の `resolveWorktree(repo)`。
- **branch 束縛**: `ticket` がある場合、`actualBranch ===
  policy.branch_prefix + ticket` を要求（worktree.sh と spine-prepare は
  常に `feat/<T>` を作る）。単なる `startsWith(prefix)` ではない。これで
  ツリー ↔ ticket ↔ branch が、人間が見る一貫した 1 つの主張に固定される。
  legacy リクエストは prefix のみのチェックを維持（そのブランチ名は契約上
  ticket 由来ではない）。

### 送信側（harness）

coder 側の両エントリポイントは既にチケットを決定論的に知っている — LLM は
一度も打ち込まない:
- **spined**: ホスト側ランチャーが `.mcp.json` の引数に `--ticket <T>` を
  焼き込んで起動する; executor の repoDir は ledger 上で既に
  `tasks/<T>/repositories/<repo>`。ticket を `publish()` のリクエストに
  通す。この経路では常に送信。
- **classic spine / drive**: `harness/src/exec.ts` の `deriveTicketRepo()`
  が repoDir レイアウトから `<ticket>` を導出済みだが、未 export かつ
  per-ticket でないレイアウトで throw する — R3 で `null` を返す export
  された non-throwing 版を追加（レビュー指摘 8）。レイアウトが per-ticket
  でない ⇒ `ticket` を送らない — legacy 経路。

### telemetry / 帰属の不変条件修正

`broker/src/config.ts` の `ticketFromWorktreesRoot()`（env 由来）は legacy
リクエストの帰属ソースであり続ける。ticket 搭載リクエストについては、broker
は**検証済み + 登録済み**のリクエスト ticket に帰属させる — これは「broker は
ticket を自分自身の env から導出し、coder のリクエストからは決して取らない」
という不変条件（docs/devcontainer-status.md item 10 — この不変条件の唯一の
記載場所; item 10 には item-11 による AMENDED 注記を追加済み）を次のように
修正する: 「…**未検証の**リクエスト値からは決して取らない; ticket の主張は
bare-name 検証とレジストリ所属の両方を通過した場合のみ帰属に受理される —
broker がそれに基づいて*行動する*のと同一の条件」。reviewer コンサルトの
`ticket` フィールド転送も同じルールに従う。承認ヘッダと `mrw serve` ページは
この同じ値を表示する — 表示の出所が env 由来から主張由来に変わる。まさに
そのためにレジストリという前提条件が存在する。

### compose / ランチャー配線

- `.devcontainer/docker-compose.yml` の broker サービス: `broker-tickets` の
  `:ro` ディレクトリバインド（`${MRW_STATE_ROOT:-..}/broker-tickets`）と
  `BROKER_TASKS_DIR` env を追加。**調整メモ:** このファイルは pre-merge
  blockers ワークストリーム（policy のディレクトリバインド de-bake）が並行
  編集中 — この変更はあちらの着地の上にリベースすること（逆にしない）。
- `scripts/devcontainer-up.sh`: up 前にレジストリディレクトリを `mkdir -p`
  （既存の state ディレクトリ事前作成と同じ理由: 放置すると Docker が
  root 所有で作ってしまう）。
- `.gitignore`: `broker-tickets/`。

## 不変条件（何が変わり、何が変わってはならないか）

| 不変条件 | before | after |
|---|---|---|
| push token は broker の env のみ | 不変 | 不変 |
| policy（hosts/orgs/prefix）は broker 自身のもの・fail-closed | 不変 | 不変 |
| git オブジェクトからの ground-truth diff、人間の SHA ゲート | 不変 | 不変 |
| worktree 解決のベース | オペレーター env（単一 dir） | オペレーター env（tasks ベース）+ 登録済み主張の `<ticket>` セグメント |
| broker の ticket 帰属 | 自身の env のみ | 自身の env（legacy）/ 検証+登録済みの主張（routed） |
| branch チェック | prefix 一致 | prefix 一致（legacy）/ `== prefix+ticket`（routed） |
| レジストリ | — | ホストのみ書き込み、broker `:ro`、決して coder-writable にしない |

## フェーズ

- **R1** — 本メモ + 独立レビュー（セキュリティ境界の変更: このワークスペース
  自身のルールによりレビューは必須）。
- **R2** — broker: スキーマ + レジストリ所属（readdir 厳密一致）+ 解決 +
  branch 束縛 + failure codes + **`renderHeader` の ticket 行** + F6 の
  レジストリ再チェック + テスト（broker/test/: case-alias エントリと
  ゲート中登録解除ケースを含む）。イメージ焼き込みのため
  `docker compose build broker` が必要 — 明示的な名前付きオペレーター手順。
- **R3** — harness: spined + classic の publish 送信側とバージョンスキュー
  診断（+ テスト）; ホストスクリプト: Phase-2.2 パスガード付きの登録/登録
  解除 + compose/gitignore/up.sh 配線; chat-selfcheck に routed-publish
  プローブを追加（未登録チケットのリクエストが `ticket_not_registered` で
  落ちること — C4 の教訓: 姿勢チェックは実機で失敗した経路そのものを叩か
  なければならない）。
- **R4** — ライブ E2E: 2 チケットを同時に開き、それぞれブラウザゲート経由の
  routed publish を、**broker 再作成なしで交互に**実施 — broker はシングル
  フライトのまま（同時 2 リクエスト目には `busy`; 不変であり、リグレッション
  ではない — レビュー指摘 11）; 加えて負のプローブ（未登録チケット）。

## スコープ外

- チケットごとの broker インスタンス / compose 生成（Thread A 残件）。
- pre-merge blockers ワークストリーム（push-guard canonicalize、triage
  姿勢、telemetry 網チェック）— 独立; 上記 compose ファイルのリベース注記
  だけが運用上の結合点。
- `BROKER_WORKTREES_DIR` の廃止 — legacy / 単一リポジトリ配備のために残す。
