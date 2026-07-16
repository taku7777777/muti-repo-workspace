# `mrw` 化 計画・実行状況・実現方法

> 作業ブランチ: **`feat/mrw`**（master 未マージ。一通り完了後にまとめて PR 予定）
> 設計の正典: [docs/mrw-cli.md](docs/mrw-cli.md)（+ [.ja.md](docs/mrw-cli.ja.md)）
> 最終更新: 2026-07-16

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

独立した 2 スレッドに分解した。

### Thread A — 状態をツールの外へ（CLI 化）
- ツール（skills / harness / broker / reviewer / compose / templates）と
  生成状態（`repositories/` `tasks/`）の癒着を切り離す。
- `.mrw/` を git 方式で発見する per-workspace config。compose は config から
  パラメータ化。`task-up` 末尾に **read-only 型付き triage leaf**（チケット整理・
  種別判断、ここで `work_type` を確定）。
- ビルド形態は **独立バイナリ `mrw`**（skills-in-session ではなく）。

### Thread B — ブラウザ承認（独立・未着手）
- 差分概要 / レビュー結果 / 全 diff を Web で綺麗に表示。
- ただし**承認行為は SHA 打鍵を維持**（唯一の権威ゲート。ボタン1押しに退化させない）。
- 配信は **token を持たない別プロセス `mrw serve`** が担い、broker が SHA を再検証。
  localhost バインド + トークン/CSRF 必須。

### 合意済みの設計判断
- `purposes/` は toolHome 既定のまま（当面は上書きなし）。
- named volume（spine-notes / review-diffs）は既定保持、`mrw close --purge` で破棄。
- 承認サーバは broker 同居ではなく別 `mrw serve`。

## 2. 現在の実行状況

### ✅ 完了（すべて feat/mrw に push 済み）

| フェーズ / スライス | 内容 | コミット | 検証 |
|---|---|---|---|
| **Phase 1** | `repositories/`+`tasks/` を config の `state_root` で外部化 | `8ee3003` | 静的 + 独立レビュー + **ライブ検証**（外部 dir にコンテナが mount） |
| **Phase 2.1** | `mrw` CLI ディスパッチャ（薄いラッパ） | `83d6a9c` | cwd 非依存 / config round-trip byte-clean |
| **Phase 2.4** | task-up triage leaf（LLM 型付き分類）+ mrw 配線 | `99f2035` | 81/81 tests + **ライブ triage** |
| **Phase 2.3** | native macOS 経路パリティ（外部 state_root 対応） | `52ad98e` | **機能シム**（add-repository を実走） |
| **Phase 2.2** | per-workspace config `.mrw/`（複数ワークスペース） | `abea32b` | 独立レビュー + **セキュリティ修正** + exploit ブロック検証 |

（前提: `dfbea8c`/`b69414a` = per-ticket OTEL telemetry、`52dcce4` = 設計メモ、
`bc0c69e`/`034a4a6` = DEMO-6/7 記録 も同ブランチに含む）

### ⏳ 残タスク
- **Thread B（ブラウザ承認 / `mrw serve`）** — 未着手。
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
  `runPlan` と同一の read-only posture（`READ_ONLY_TOOLS`+`DENY_MUTATION`+
  `settingSources:[]`、repo cwd なし、text のみで分類）。
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
