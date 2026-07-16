# `mrw chat` — Claude Code をチャットフロントエンドに（設計メモ）

**Status: 設計合意済み（2026-07-16）、未実装 — `mrw` 化の Thread C。**
C1 スパイクは**合格（GO）**、同日の独立 adversarial レビューは
SHIP-WITH-FIXES — いずれも本文に反映済み。
[agent-orchestration.md](agent-orchestration.ja.md)（このメモが「顔」を付ける
spine / M1–M4 制御プレーン）と [mrw-cli.md](mrw-cli.ja.md)（Thread A & B）の
姉妹メモ。2026-07-16 にオペレーターと対話で決定。

> 🇬🇧 English version: [mrw-chat.md](mrw-chat.md)

## 動機

M2 のチャット面（`npm run chat` → `spine/repl.ts`）は素の readline REPL で、
体験の穴が明確:

- アシスタント出力は生テキスト垂れ流し — markdown なし・色なし;
- **ツール呼び出しが不可視** — `run_worker` が数分走っても無反応
  （スピナーも経過時間も「何をしているか」もない）;
- 割込み（Esc）なし・入力履歴の永続化なし・複数行編集なし・resume なし;
- コマンドは `/quit` のみ; ステータス表示（ticket / repos / budget）なし;
- publish 承認は 200 行に切り詰めた diff の表示 + `y/N` 一行。

ゴール: orchestrator チャットに **Claude Code 級の対話体験**を、
**UI とエンジンの改善を結合させずに**実現する — インターフェース層は
エンジンロジック（executor / ledger / steps / workerd / broker）と独立に
改善できなければならない。

## 決定

**Claude Code そのものをフロントエンドにする。** spine エンジンを対話
Claude Code セッションに **MCP サーバ**として見せる。セッション内の LLM は
typed な MCP ツールを呼んで spine アクションを *propose* するだけで、
coded spine が *dispose* する構図は不変。Claude Code は「素のまま」ではなく、
既存の orchestrator コンテナの檻の中で、**生成された固定構成**
（deny 姿勢の settings・persona CLAUDE.md・`.mcp.json`・バージョン固定 CLI）
の下で走る。

得られるもの:

- 体験は*定義上* Claude Code 級（markdown・ストリーミング・ツール表示・
  ライブ進捗・Esc 割込み・履歴・`--continue` resume・スラッシュコマンド）。
  将来の Claude Code 改善も自動で享受;
- UI/エンジンの縫い目が **MCP ツール契約**になる — UI 改善は
  config/persona/テンプレートの仕事、エンジン改善はデーモンの仕事。
  互いにブロックしない;
- 自作 TUI のビルド・保守コストがゼロ。

不採用の代替案:

- **自前 TUI（Ink）+ typed イベントプロトコル** — 自由度と allowlist 姿勢の
  純度は最大だが、Claude Code 同等の到達・維持はそれ自体が恒常的な
  開発プロジェクトになる。**フォールバック（B-lite）**として保持 — ただし
  C1 スパイクで体験の核が成立したため、発動は想定しない（フェーズ参照）。
- **`mrw serve` 同居のブラウザチャット** — 描画は最もリッチだが、
  ターミナル/cmux 運用から乖離し、未着手の Thread B に依存する。

非対話の LLM leaves（triage / plan / review / worker steps）は**触らない**:
Agent SDK + typed schema + 固定 read-only 姿勢のまま。Claude Code に乗るのは
真に対話的な唯一の面 — orchestrator チャット — だけ。

## アーキテクチャ

### 新規部品（すべて追加のみ）

- **`harness/src/spined/`** — *既存の* executor/ledger を包む stdio MCP
  サーバ（`workerd/` と同じパターン: 薄いプロトコルアダプタ、新権限なし）。
  フロントエンドが `.mcp.json` 経由で spawn; 生成された config の argv から
  `--ticket/--repos/--purpose` を受ける。
  - **prepare はデーモンではなく launcher の仕事**: `mrw chat` がセッションを
    開く*前に*、worktree 準備 + ledger 種まき（今の `spine/index.ts` `cli()`
    前段）を明示的な in-container prepare ステップとして実行する。spined は
    即座に起動し（stdio MCP サーバには startup timeout がある）、ledger を
    **ロードするだけ**。ledger 不在は prepare コマンド名を示す fail-closed な
    起動エラー。
  - 公開ツール: `run_worker`, `run_tests`, `plan_repo`, `review_diff`,
    `request_publish`, `status`, `done`, `abort`。`status` は **budget 免除**:
    `executor.dispatch()` の*外*で read-only な ledger スナップショットを読む
    （dispatch されるアクションは設計上すべて budget を消費する —
    「いつでも呼べる」status が budget を溶かしてはならない）。
  - **チケットごと単一インスタンス**: spined は ledger dir に排他 lockfile を
    取る; 同一チケットへの 2 個目のデーモン（2 枚目のチャットタブ）は明確な
    メッセージで fail-closed。これがないと executor が 2 つになり budget
    レールが倍増し、ledger は last-writer-wins で壊れる。**旧 REPL はまだ
    このロックを取らない** — chat + REPL の同時起動は REPL がロックを採用する
    まで未強制（C4 で追跡）。
  - **keep-alive 進捗**: 長い dispatch（`run_worker`、分単位）の間、デーモンが
    タイマーから粗い MCP progress notification を発する
    （「run_worker … Ns elapsed」、~10 秒間隔）。C1 で TUI にライブ描画される
    ことを実証済み。これは境界側のナレーションのみ — *workerd 内部*の
    進捗ストリーミングはスコープ外のまま（下記参照）。
  - `ask_human` / `show_human` は**公開しない** — チャットそのものが人間
    チャネルになったため。旧 REPL 経路（headless/フォールバックとして温存）
    向けに executor 内には残す。
- **生成フロントエンド構成 — orchestrator 専用の面に render する。**
  信頼される host 側 launcher（root console 層）が
  **`STATE_ROOT/chat/<ticket>/`** に render する — `tasks/` の*兄弟*で、
  worker には決してマウントされない; render 先のパスに **`tasks/` セグメントが
  含まれる場合は拒否**（`mrw init` と同じガードクラス）。コンテナへは既存の
  read-only workspace/state オーバレイ経由で届く。これが重要な理由:
  `.mcp.json` はフロントエンドが orchestrator コンテナ内で spawn する
  コマンドラインであり、settings.json は deny 姿勢の全体を担う — どちらかが
  worker-writable なら、侵害された worker が姿勢を剥がすか orchestrator
  コンテナ内でコード実行できる（Phase 2.2 が `.mrw/` で塞いだのと同じ
  脆弱性クラス）。コンテナ home への trust スタンプ
  （`projects[<dir>].hasTrustDialogAccepted`）も launcher が書く。
  - 内容: settings.json（deny 姿勢; `permissions.allow: ["mcp__spine__*"]`;
    初回起動が MCP 承認プロンプトで止まらないよう
    `enabledMcpjsonServers: ["spine"]`; `model` は sdk.ts の
    `MODEL`/`HARNESS_MODEL` と同じ情報源から render; OTEL env;
    `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT` を **worker step budget（既定 45 分）より
    上に固定** — 長い `run_worker` 中にデーモンが busy のままクライアント側で
    中断されないように）、persona CLAUDE.md（今の `buildSystemContext()`
    テキスト）、`.mcp.json`（spined の stdio 起動コマンド）、repo パスへの
    `claudeMdExcludes`。
- **配線**: `mrw chat <ticket>`（および `mrw task-up` の末尾）が prepare を
  実行し、config を render し、cmux タブで orchestrator コンテナ内の
  `claude` を起動（`docker compose exec -it orchestrator claude …`）;
  resume は同一ディレクトリでの `--continue`。**当面はコンテナ専用**:
  スタックが上がっていなければ launcher は拒否する — native 実行だと deny
  settings が*唯一の*檻になり（squid なし・`:ro` マウントなし）、本設計は
  それを安全と主張しない。orchestrator コンテナの home には named volume
  （`chat-home`）を与え、会話履歴がコンテナ再作成を生き延びるようにする。

### 意図したエンジン適応（正直なリスト — もはや「ゼロ」ではない）

すべて小さく、すべてここで仕様化し、すべて C2 でテストする。これ以外の
executor/ledger/steps/workerd は不変:

1. **注入式 approval policy**（`in-chat` | `broker-only`、既定 `in-chat`）:
   y/N ゲートは REPL ではなく `executor.ts` にあるので、無条件に「publish
   経路から外す」と旧 REPL からも黙って剥がれてしまう。REPL は今日の
   in-chat ゲートを byte 単位で維持; spined は `broker-only` を注入
   （尋ねるターミナルが存在しない）。
2. **終了後 dispatch の拒否**: 今日はセッション終了を REPL ループが強制
   している; spined にはループがないので、`done()`/`abort()` 後の dispatch は
   executor 自身が typed な `session_ended` エラーで拒否する。
3. **ledger の load-or-seed**: `SpineLedger` は今日 persist 専用; resume で
   budget が黙って全快し、`baseSha` が*現在の* HEAD から再導出される
   （以後の review/publish 本文が再起動後の差分しか覆わなくなる）。
   永続化された ledger — baseSha・budget・記録済み verdict — をデーモン起動時に
   ロードする; `--continue` が会話を、ledger がエンジンを復元する。
4. **broker 算出の caveat**（ゲートポリシー参照）: broker に加算 ~20 行の
   coded 行 + テスト（broker は image-baked — rebuild 必要）。

### 姿勢の等価対応（SDK options → settings）

| 現在（`spine/session.ts`） | フロントエンド側 | 備考 |
|---|---|---|
| `tools: [Read, Grep, Glob]`（allowlist） | `permissions.deny: [Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch, Task, …]` | deny はセッション内から非バイパス（doc 確認 + C1 実測: deny された built-in はセッションから消える）; **allowlist→denylist の反転** — 下のドリフト対策参照 |
| `settingSources: []`（CLAUDE.md 遮断） | 中立 cwd（`STATE_ROOT/chat/<ticket>/`、repo ではない）+ repo パスの `claudeMdExcludes` | 残余リスクは native 経路 orchestrator が既に許容済みの同種露出 |
| `permissionMode: bypassPermissions` | 既定モード + `permissions.allow: ["mcp__spine__*"]` | 誤承認の余地なし: built-in は deny で即拒否、spine ツールは事前許可（ディレクトリ trust スタンプが前提 — launcher が自動化） |
| `env: telemetryEnv(ticket,"spine")` | 生成 settings の `env` ブロック | 同じ自己合成 OTEL 属性、文字列転送はしない |
| `MODEL` 定数 | settings の `model` | render 時に同じ情報源（`sdk.ts` の `MODEL`/`HARNESS_MODEL`）から生成 — 手動の同期は不要 |

ドリフト対策（denylist 反転の正直なコスト）:

1. **コンテナイメージで `claude` CLI をバージョン固定** — あわせて
   `coder.Dockerfile:31` の `|| true` を撤去し、install 失敗は CLI 欠落
   イメージを黙って出荷せずビルドを落とす。
2. **role selfcheck を拡張**（`scripts/egress-selfcheck-role.sh` の型）:
   生成 settings 下で使い捨ての `claude -p` を駆動し、Bash/Edit/WebFetch は
   deny を、`mcp__spine__status` は成功を期待; 仕込んだネスト CLAUDE.md を
   `claudeMdExcludes` が実際に抑制することも検証。

### ゲートポリシー（合意済みの方向）

権威は**不変**: broker での人間の SHA 打鍵が唯一の権威承認、
`allowed_push_orgs/_hosts` は LLM-free な broker が in-process で強制。
境界での変更:

- チャット内 `y/N` ゲートは注入式 approval policy により **spined 経路から
  のみ**消える（Claude Code 下ではチャット返答がモデル仲介になりゲートとして
  無価値のため）; 旧 REPL は維持。spined 経路の `request_publish` は:
  ledger ゲート（CURRENT head の green tests + approving review）→
  broker intent → broker SHA。
- `diffTouchesTests` の caveat（テスト独立性の警告）は **broker の中へ**移る:
  broker が自分の ground-truth diff から自ら算出し、SHA ゲートで reviewer の
  tri-state ヘッダの隣に coded な caveat 行を表示する。これは
  「broker 変更ゼロ」を意識的に手放すトレード（加算 ~20 行 + テスト +
  image rebuild）— 代替案（intent 本文への caveat 行）は「as sent by the
  coder」とラベルされ、上限なしで、LLM 作文の plan 文章に埋没させられ、
  公開 PR 本文にも漏れるため却下。broker 算出 = 偽装不能・ゲート限定・
  PR に不可視。
- MCP **elicitation** はバイナリに実在（C1）するが、真に human-only かは
  **未検証**（docs には自動応答できる Elicitation hook の記載がある）。
  高々将来の磨き込みであり、ゲートの依存には決してしない。

### 不変条件（誰が何を強制するか — 「不変の行」こそが要点）

| 不変条件 | 強制者 | 本設計下 |
|---|---|---|
| push 先（orgs/hosts） | broker in-process + pre-push フック | 不変（フロントエンドは push トークンを持たない） |
| 権威承認 = 人間の SHA | broker | 不変 |
| worker 封じ込め（broker sock なし・網なし） | compose トポロジ | 不変 |
| egress allowlist | squid | 不変（claude は既存許可済みの api.anthropic.com に話すだけ） |
| budget / serial / fail-closed レール | executor + ledger | 不変（デーモン側; + 単一インスタンス lock で倍増を防ぐ） |
| LLM の効果 = typed actions のみ | SDK ツール allowlist | settings deny（非バイパス）+ 効果は MCP のみ |
| **chat config は worker-writable でない** | —（新しい面） | launcher の render 先ガード（`tasks/` セグメント拒否）+ worker マウント構成; **C4 で検証** |

チャットを操作する人間は**信頼主体**（root console 相当）。
「タスクは自分の sandbox を広げられない」は *worker* についての不変条件の
まま。単一プロセス fallback モードでは y/N 撤去による損失はない:
`BROKER_SOCKET` 未設定なら `publish()` はハードスタブで、何も push できない。

## フェーズ

- **C1 — スパイク: 完了（2026-07-16、claude v2.1.211）→ GO。**
  (a) MCP `notifications/progress` の message がツール行の下に**ライブ描画**
  （`⎿ step 12/45s elapsed (27%)`）、スピナー / 経過 / トークン数 /
  `esc to interrupt` 付き — 体験の核は成立; (b) deny 姿勢は built-in ツールを
  セッションから丸ごと消す; `permissions.allow` はディレクトリ trust 承諾が
  前提（ダイアログが事前許可ツールを列挙）; (c) `statusLine`・
  `claudeMdExcludes`・elicitation はバイナリに実在（挙動検証は C3 の
  selfcheck へ委譲）。詳細は plan.md。
- **C2 — `spined` デーモン + 上記 4 つのエンジン適応。**
  受け入れ基準: プロトコルレベルの unit tests（workerd 式）; 旧 REPL が
  **y/N ゲート込みで** green（両 approval policy をテスト）; 終了後 dispatch は
  `session_ended` で拒否; チケットごと単一インスタンス lock; 永続化
  `baseSha` での ledger load-or-seed（resume で再導出しない）; `status` は
  budget 免除; broker caveat 行の unit test。
- **C3 — フロントエンド構成 + 配線。** 受け入れ基準: render 先ガードが
  `tasks/` セグメントを拒否; trust スタンプ自動化; `enabledMcpjsonServers`
  あり; `.mcp.json` は `tsx src/spined/index.ts` を**直接** spawn
  （`npm run` ラッパは自身のバナーを stdout に出し、spined の stdio guard が
  効く前に JSON-RPC ワイヤを壊す）; CLI の固定 install はエラー時にビルドを落とす; MCP タイムアウトを
  worker budget より上に固定; 実セッションで keep-alive 進捗が見える;
  スタック停止時に launcher が拒否（コンテナ専用）; `chat-home` volume;
  selfcheck 拡張（deny 姿勢 + `claudeMdExcludes` 挙動 +
  `mcp__spine__status` 到達性）。
- **C4 — 検証。** 不変条件チェックリスト再実行 — **新設の「chat config は
  worker-writable でない」行を含む**; [agent-orchestration.md](agent-orchestration.ja.md)
  の改訂（Q2「なぜ対話 TUI でないか」+ 不変条件 5「spine がターミナルを
  所有する」）— 記録済みの fail-open な permission 層の実測と、本設計の
  deny-rule 姿勢 + MCP 経由効果との整合を明記; 独立レビュー
  （セキュリティに触れる境界変更）; デモチケットでのライブ E2E — チャット →
  実装 → テスト → レビュー → broker SHA 経由 publish（broker 算出 caveat の
  表示確認）— に加えて resume の脚（デーモン再起動後の `--continue`、
  ledger 状態保持）。

進め方は確立済みルールどおり: 実装はサブエージェントに委任、検証は
アシスタント、コミット前に独立レビュー、すべて `feat/mrw` 上。

## スコープ外（別スレッド）

- **エンジン改善** — *workerd 内部*の進捗（`run_worker` 中に worker が実際に
  何を編集しているかのストリーム）: MCP 境界は progress notification を既に
  運べるので、後から *UI 変更なしで*載せられる。上記のデーモン側 keep-alive
  ティッカーはスコープ内、本物の内部進捗はスコープ外。
- **feat/mrw の pre-merge blockers**（2026-07-16 レビュー: push-guard config
  の canonicalize、triage leaf の姿勢、telemetry 網の internal 検証）—
  独立したワークストリームで、相互依存なし。
- **Thread B**（ブラウザ承認 / `mrw serve`）— 不変; 本メモのゲートポリシーは
  Thread B と合成可能（ブラウザは同じ intent + broker 算出 caveat を描画、
  SHA が承認行為であり続ける）。
