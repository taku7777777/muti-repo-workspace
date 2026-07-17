# `mrw` 化 計画・実行状況・実現方法

> 作業ブランチ: **`feat/mrw`**（PR #13 で a8d972b までは master マージ済み。
> それ以降 = env-sanitize / pre-merge blockers / broker ticket routing が未マージ分）
> 設計の正典: [docs/mrw-cli.md](docs/mrw-cli.md)（+ [.ja.md](docs/mrw-cli.ja.md)）
> 最終更新: 2026-07-17

## 0. 概要（何を目指すか）

`muti-repo-workspace` を「そのディレクトリで作業する固定のワークスペース」ではなく、
**`mrw` という CLI ツール** に切り出し、`repositories/` `tasks/` 相当の状態は
**事前に指定した任意のディレクトリ**に置けるようにする。

狙いのユーザー体験:
```
mrw config / mrw init   # repositories・tasks の置き場所と対象リポジトリを指定
mrw infra-up            # コンテナ群を起動
mrw task-up <link>      # タスク開始（ディレクトリ生成 + cmux + LLM でチケット整理）
# → 対話形式で実装（内部で Claude セッション）
# → broker に承認依頼（差分概要・レビュー結果・差分詳細）→ SHA 承認
```

## 1. 元々の計画（設計メモ = docs/mrw-cli.md）

独立したスレッドに分解した（当初は A/B の 2 本、のち C を追加）。

### Thread A — 状態をツールの外へ（CLI 化）
- ツール（skills / harness / broker / reviewer / compose / templates）と
  生成状態（`repositories/` `tasks/`）の癒着を切り離す。
- `.mrw/` を git 方式で発見する per-workspace config。compose は config から
  パラメータ化。`task-up` 末尾に **read-only 型付き triage leaf**（チケット整理・
  種別判断、ここで `work_type` を確定）。
- ビルド形態は **独立バイナリ `mrw`**（skills-in-session ではなく）。

### Thread B — ブラウザ承認（✅ BUILT — docs/browser-approval.md）
- 差分概要 / レビュー結果 / 全 diff を Web で綺麗に表示。
- ただし**承認行為は SHA 打鍵を維持**（唯一の権威ゲート。ボタン1押しに退化させない）。
- 配信は **token を持たない別プロセス `mrw serve`** が担い、broker が SHA を再検証。
  localhost バインド + トークン/CSRF 必須。

### Thread C — 対話 UX（chat surface の Claude Code 化）
> 設計の正典: [docs/mrw-chat.md](docs/mrw-chat.md)（+ [.ja.md](docs/mrw-chat.ja.md)）
- M2 チャット面（素の readline REPL）を **Claude Code そのもの**に置換。
  spine エンジンを stdio MCP デーモン（`harness/src/spined/`）に切り出し、
  Claude Code は typed な `mcp__spine__*` を propose するだけ（dispose は
  coded spine のまま）。UI/エンジンの縫い目 = MCP ツール契約。
- Claude Code は「素のまま」ではなく生成固定構成の下で:
  deny 姿勢 settings（非バイパス）+ persona CLAUDE.md + `.mcp.json` +
  イメージにバージョン固定した CLI。既存 orchestrator コンテナの檻の中。
- ゲート: チャット内 y/N は spined 経路のみ注入式 approval policy で外し
  **broker SHA に一本化**（旧 REPL は y/N 維持）。`diffTouchesTests` caveat は
  **broker が ground-truth diff から自ら算出**して SHA ゲートに表示
  （加算 ~20 行のみ。権威・ポリシーは不変。intent 本文行案は
  埋没・公開 PR 漏れのため独立レビュー指摘で却下）。
- 非対話 LLM leaves（triage/plan/review/worker）は SDK のまま不変。
  旧 REPL は headless/フォールバック経路として温存。
- フォールバック（B-lite = Ink で主要ギャップのみの小 TUI）を C1 スパイク
  不成立時の撤退線として保持。

### 合意済みの設計判断
- `purposes/` は toolHome 既定のまま（当面は上書きなし）。
- named volume（spine-notes / review-diffs）は既定保持、`mrw close --purge` で破棄。
- 承認サーバは broker 同居ではなく別 `mrw serve`。
- 対話 UI は Claude Code を採用（Thread C、2026-07-16 合意）。承認の権威は
  broker SHA のみ（チャット内 y/N は spined 経路から廃止、REPL は維持）。
  UI 改善はエンジンロジック改善と独立に進められること（境界 = MCP 契約）。
  設計メモは独立レビュー（SHIP-WITH-FIXES、16 件）を全件反映済み。

## 2. 現在の実行状況

### ✅ 完了（すべて feat/mrw に push 済み）

| フェーズ / スライス | 内容 | コミット | 検証 |
|---|---|---|---|
| **Phase 1** | `repositories/`+`tasks/` を config の `state_root` で外部化 | `8ee3003` | 静的 + 独立レビュー + **ライブ検証**（外部 dir にコンテナが mount） |
| **Phase 2.1** | `mrw` CLI ディスパッチャ（薄いラッパ） | `83d6a9c` | cwd 非依存 / config round-trip byte-clean |
| **Phase 2.4** | task-up triage leaf（LLM 型付き分類）+ mrw 配線 | `99f2035` | 81/81 tests + **ライブ triage** |
| **Phase 2.3** | native macOS 経路パリティ（外部 state_root 対応） | `52ad98e` | **機能シム**（add-repository を実走） |
| **Phase 2.2** | per-workspace config `.mrw/`（複数ワークスペース） | `abea32b` | 独立レビュー + **セキュリティ修正** + exploit ブロック検証 |
| **Thread B** | ブラウザ承認 — `mrw serve`（token-less コンテナ）+ broker approval socket。SHA 打鍵は broker が in-process 再検証、TTY ゲートとレース。GitHub パリティ UI + `.mrw/serve.json`/`serve.css` カスタマイズ | (次コミット) | broker 36 + serve 120 tests / 実ブラウザ CDP E2E（XSS DOM 検査・SHA 承認実走）/ HTTP セキュリティ 11+23 項目 / compose 実機（`mrw serve up`→healthy）/ 独立セキュリティレビュー = ブロッカーなし |

（前提: `dfbea8c`/`b69414a` = per-ticket OTEL telemetry、`52dcce4` = 設計メモ、
`bc0c69e`/`034a4a6` = DEMO-6/7 記録 も同ブランチに含む）

### ⏳ 残タスク
- **Thread C（対話 UX / Claude Code フロントエンド）** — 設計合意済み（docs/mrw-chat.md）。
  - C1: ✅ スパイク完了（2026-07-16、claude v2.1.211 実測）→ **GO**。
    (a) MCP progress notification の message が TUI にライブ描画
    （`⎿ step N/45s elapsed (7%)` + スピナー/経過/トークン/esc to interrupt）;
    (b) deny 姿勢は built-in ツールをセッションから**消す**形で有効
    （allow はディレクトリ trust が前提。trust ダイアログが事前許可ツールを列挙）;
    (c)(d)(e) claudeMdExcludes / elicitation / statusLine はバイナリに実在確認
    （挙動検証は C3 selfcheck に委譲）。
  - C2: ✅ harness スライス完了（`20ddb6e`）— spined デーモン（fail-fast 起動 +
    spine-prepare + atomic rename ロック + keep-alive 進捗 + budget 免除 status +
    stdio guard）+ エンジン適応（approval policy / session_ended / ledger
    versioned load）。独立レビュー SHIP-WITH-FIXES → 全件反映、166/166 tests。
    broker caveat スライス（broker 算出 caveat + renderHeader テスト、43/43）は
    Thread B land 後に続けてコミット済み。
  - C3: ✅ 完了 — templates/chat-frontend（deny 姿勢 + additionalDirectories +
    enabledMcpjsonServers + MCP timeout 派生）、`mrw chat` launcher
    （canonicalize 済み `tasks/` セグメント拒否ガード / spine-prepare /
    2 キー trust スタンプ / cmux / --resume）、compose chat-home volume
    （CLAUDE_CONFIG_DIR）、claude@2.1.211 固定（`|| true` 撤去）、
    chat-selfcheck（4 プローブ、ground-truth 判定）。独立レビュー **REWORK**
    （settings.json レンダー先誤り = 姿勢不発の BLOCKER 等 13 件）→ 全件修正 +
    **ライブ再検証**（deny でツール消滅 / MCP 承認プロンプトなし /
    selfcheck 4/4 / egress 開通 / model 一致）。shell 66 + harness 166 +
    broker 43 全緑。egress allowlist に platform.claude.com 追加
    （オペレーター承認済・squid ログ証拠付き。**egress-proxy はイメージ
    rebuild が必要** — allowlist は COPY 焼き込み）。
    既知の残 UX: chat-home volume 初回のみ CLI onboarding（テーマ/ログイン）
    の人間クリックスルーが必要。
  - C4: ✅ ライブ E2E 完了（2026-07-17、ETE-1 → phase2-demo#4）— chat →
    run_worker → tests green → plan → review approve → request_publish →
    ブラウザ SHA ゲート（caveat バッジ・keep-alive 描画・resume レグ込み）→
    実 push + PR。E2E でのみ発見できた 2 バグ: (1) `.mcp.json` の未展開
    `${VAR}` プレースホルダを実クレデンシャルと誤認（FIXED `8c4570f`
    env-sanitize）、(2) broker の worktree 参照が起動時 env 固定で
    per-ticket publish 不能 → **broker ticket routing**（下記）として解決。
    残: 最終独立レビュー（devcontainer-status 記録は item 11 で完了）。
- **broker per-ticket routing（設計 → R4 ライブ検証まで完了 2026-07-17）** —
  docs/broker-ticket-routing.md（独立レビュー SHIP-WITH-FIXES 全11件反映
  `40f4b7f`）。R2 broker 実装 `dedaffd`（53/53）+ R3 送信側/レジストリ/配線
  `b621372`（harness 173・shell 114）。R4 ライブ: RT-1（phase2-demo#5）+
  RT-2（phase3-docs#2）を **broker 再作成なしで同一 broker から連続 publish**
  （多重度 N 実証）; 未登録チケット socket プローブ 5 種; **F6
  ゲート中登録解除 → 正しい SHA 承認でも fail-closed** を実機確認。
  `BROKER_GITHUB_TOKEN` の export だけで複数チケット publish 可能に
  （`BROKER_WORKTREES_DIR` の手動向け替え儀式は不要化・legacy 互換維持）。
  R4 で判明した残ギャップ（別スライス候補）: workerd はスタック単一・
  シングルフライトで並行チケットのステップが busy 競合し、**busy 拒否も
  worker-run 予算を消費**する（RT-2 で 3/12 空費）; `run_tests` は
  `npm test` 前提で package.json の無い docs リポジトリはゲート不能
  （per-repo TEST_COMMAND 未対応。RT-2 は no-op test script 追加で回避）。
- **feat/mrw pre-merge blockers（2026-07-16 独立レビュー）** — ✅ 修正済み・
  コミット済み（`440da38`、全スイート検証後にランド）。push-guard config の
  canonicalize / triage leaf の tool-less 化 / telemetry 網 internal 検証を完了。
- ~~**Thread B（ブラウザ承認 / `mrw serve`）**~~ — ✅ 完了（上の表参照）。
  残フォローアップも消化済み: 2026-07-17 の `infra-up --build` 後、C4
  （ETE-1）と routing R4（RT-1/RT-2）でコンテナ内 broker のブラウザ承認
  ライブ E2E を計3回実施（うち1回は F6 fail-closed の負系）。
- **work_type → telemetry の per-ticket 配線** — 現状 stack 共有のため `MRW_WORK_TYPE`
  は stack 単位。per-ticket 帰属は別途要設計（telemetry の per-ticket 分離議論に接続）。
- **master へのマージ（PR 作成）** — 一通り完了確認後。

## 3. 実現方法（アーキテクチャ要点）

### 状態の外部化（Phase 1）
- `common.sh` に `state_root()`（config の `.state_root`、既定 = tool_home）。
  ホストスクリプトの `repositories/`+`tasks/` 参照のみ `STATE_ROOT` へ。
- compose のバインドを `${MRW_STATE_ROOT:-..}` でパラメータ化 + orchestrator/broker
  に state のネスト `:ro` オーバレイ。reviewer は無変更（workspace 無マウント）。
- `broker-policy.json` を build-COPY → **runtime bind** に de-bake。
- **相対 worktree 不変条件**を維持（origin と tasks を state_root 配下の兄弟に）。
- pre-push フックの `includeIf` を tool_home と state_root の**両スコープ**に。
- **完全後方互換**: `state_root` 空なら現状と byte 単位で同一。

### `mrw` CLI（Phase 2.1）
- `cli/mrw.mjs` = **依存ゼロの単一 plain JS ESM**（`#!/usr/bin/env node`）。
- toolHome を `import.meta.url` から解決 → **どこからでも実行可**。
- 各サブコマンドは `spawnSync(scriptPath, args, {stdio:"inherit", cwd:toolHome})`
  で既存スクリプトへディスパッチ（`shell:true` なし = インジェクション耐性）。
- サブコマンド: `config` / `init` / `setup` / `infra-up` / `infra-down` /
  `task-up` / `list` / `close` / `doctor`。

### triage leaf（Phase 2.4）
- `harness/src/triage.ts` `runTriage(text, repos) → {work_type,title,repos,summary}`。
  tool-less posture（全 built-in tool deny + `settingSources:[]`、不活性 cwd、
  text のみで分類）。
- `work_type` は検証済み enum、`repos` はコードで availableRepos との積集合に絞る。
- `mrw task-up --from <link>`（ticket-source で取得）→ triage → title/repos 自動補完。
  **graceful degradation**: triage 失敗（auth/gh/API）でもタスク作成は止めない。
- 起動: `npm run triage`（stdin / `--text-file` → JSON）。

### native 経路パリティ（Phase 2.3）
- `add-repository.sh`: `{{WORKSPACE_ROOT}}`（tool_home）を焼き込み、存在すれば使用・
  無ければ `TASK_DIR/../..` フォールバック（統合コンテナ対応）。origin は `state_root()`。
- `create-workspace.sh` は cp ではなく **render** で焼き込み。
- root console に `additionalDirectories:["{{STATE_ROOT}}"]`（外部 state への書込境界）。

### per-workspace config（Phase 2.2）
- config 解決（common.sh / pre-push / mrw.mjs の**3実装が一致**）:
  `$MRW_CONFIG_DIR` > 上位へ辿って見つかる `.mrw/workspace.json` > `toolHome/config`。
- ワークスペース = `.mrw/` を持つディレクトリ（配下に repositories/tasks）。
  state_root 既定 = `.mrw` の親。
- pre-push フックは**自前で walk-up**発見（env 非依存）。broker-policy は
  `${MRW_CONFIG_DIR:-../config}/broker-policy.json`（コンテナ経路の authoritative）。
- `mrw init [dir]` で `.mrw/` を雛形生成。
- **セキュリティ修正（独立レビューで発見 → コミット前に修正）**:
  worker-writable な worktree（`tasks/**`）に仕込まれた `.mrw/` で push-org ガードを
  迂回できる脆弱性 → 3実装すべてで **`tasks/` セグメント配下の `.mrw/` を拒否**し、
  その上の正規 config まで辿る。`mrw init` も tasks/ 配下を拒否。exploit ブロックを検証。

## 4. 進め方（運用ルール）
- 実装は Sonnet 5 サブエージェントに委任、**検証・チェックは私（アシスタント）が実施**。
- 成果物は**別コンテキストの独立レビュー**にかけ、指摘を反映してからコミット。
- セキュリティ経路に触れる変更（Phase 1 / Phase 2.2）は独立レビュー + ライブ検証を必須。
- すべて `feat/mrw` に commit & push。**master へは一通り完了後にまとめてマージ**。

## 5. 不可侵の制約（維持している不変条件）
- egress allowlist（Squid）/ `mrw-telemetry` internal 網。
- 5 ロール封じ込め（worker は broker socket を持たない / reviewer は workspace 無マウント）。
- broker は LLM-free、SHA 打鍵が唯一の権威承認。
- `allowed_push_orgs`/`_hosts` は broker が in-process で強制（authoritative）+
  pre-push フックが defence-in-depth。
- 生成ファイルは手編集せずテンプレ + スクリプトで再生成。
