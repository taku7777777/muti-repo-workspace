# 08 — 検証計画・受け入れ基準
日付: 2026-07-17(2026-08-02 の §12.1 移行で遡及付与。値はファイルの最終更新時刻 —— 初版コミットは保存と同日のため)

再構築システムが「元と同等」であることの判定基準。fork/カスタマイズ後・Claude Code
アップグレード後・`templates/`/`scripts/` 変更後にも同じ手順を回す。

## 8.1 検証シーケンス(ネイティブ経路)

### Step 0 — ユニットテスト(秒、自動)
`bash tests/run-tests.sh`。パス正規化・テンプレート描画・上書き優先順位・チケットID
検証・pre-push の org/host 抽出、すべて green(実績 40/40)。最後に harness スイートを
ガード付きで実行(`tsx -e` の実変換プローブで実行可能性を確認してから `npm test`。
プラットフォーム不一致の esbuild ならスキップ)。

### Step 1 — セットアップ(自動 + 手動 trust)
`bash scripts/setup-workspace.sh` 後に確認:
- `config/repos.json` の実リポジトリ全部が `repositories/` にクローン済み
- `.claude/settings.json` と `repositories/.claude/settings.json` が存在
- `git config --global --get includeIf.gitdir:<root>/.path` が
  `<root>/.gitconfig-workspace` を指す(state_root 外部化時は両スコープ)
- `~/.cmux-wait.sh` / `~/.cmux-state.sh` が実行可能
- root で `claude` 再起動 → trust 承認 → 「Ignoring N permissions.allow entries」警告が
  **出ない**こと

### Step 2 — タスク作成(cmux なし)
```bash
bash scripts/create-workspace.sh --ticket TEST-001 --purpose dev --repos "<repo>" \
  --title "verify" --phase init --yes
bash scripts/create-workspace.sh --ticket TEST-001 --phase finalize --yes
```
`tasks/TEST-001/` で確認:
- worktree がブランチ `feat/TEST-001` に存在。knowledge リポジトリは
  `sparse_paths.<purpose>` のディレクトリのみ
- `agents/{worker,orchestrator}/` に CLAUDE.md / initial-prompt.md / 有効な JSON の
  `.claude/settings.json` / 空 `.git` ファイル
- worker の `allowWrite` に origin `.git` が**含まれない**
- per-repo denyWrite ピン: `repositories/<repo>/.git/config`、`.../.git/hooks`、
  worktree の `config.worktree`
- worker / orchestrator settings の denyWrite に、正規化・解決済み `config_dir` が含まれる
- `.task-meta.json` に正しい purpose/repos/branch
- worker `additionalDirectories` はタスクディレクトリ**のみ**(S2-o)
- **バイト一致**: orchestrator の `excludedCommands` 各エントリ(末尾 ` *` を除く)が
  `agents/orchestrator/CLAUDE.md` に逐語で現れ、`~` 展開先にファイルが実在する

### Step 2a — ticket-source と purpose 切替(自動 + API はスクラッチ issue)

- `github-issues` の `fetch_ticket <id-or-url>` を使い、stdout が余分な文字のない
  `{id,title,body,url}` JSON であることと、その値が `docs/task.md` に反映されることを確認する。
  存在しない issue/認証失敗では非ゼロとなり、open-task/task-up が手入力へ移ることも確認する。
- 異なる `default_repos` / `mcp_servers` を持つ purpose を2つ用意する。各タスクで repos が
  切り替わり、選択したサーバだけが `templates/default/mcp.json` の定義と一致して
  `agents/{worker,orchestrator}/.mcp.json` の `mcpServers` に生成されることを確認する。
  未知サーバ名は警告され、生成物には含まれないこと。

### Step 3 — cmux + エージェント(ライブ)
両エージェントディレクトリを trust → `--phase cmux --yes`。確認:
- cmux ワークスペース `TEST-001` に3タブ
- `.worker-target` に workspace UUID + tab-1 surface UUID
- worker が `docs/task.md` を読み始め、権限警告なし
- 最初の handoff report 後に idle(exit しない)
- orchestrator から指示送信 → background の wait → `RESULT status=idle` → 最新 handoff を
  Read で読める → worker がコミット済み

### Step 4 — publish 経路(ライブ)
- `allowed_push_orgs` に org が**無い**状態 → pre-push がブロック
- org 追加後 → push 成功、PR 作成(スクラッチリポジトリで)
- worker からの `git push` → 失敗(ネットワークなし)

### Step 5 — 回帰トラップ(古典的な壊し方)

| トラップ | 期待挙動 |
|---|---|
| 除外スクリプトを相対パス / `bash <path>` で実行 | 非ゼロ exit で拒否され、サンドボックス外では実行されない。リテラルパス形のみ動く |
| **worker** の excludedCommands にエントリ追加 | 決してしない — auto-allow 層で行全体が非サンドボックス化 |
| cmux `send` の後に別の `send-key enter` を送らない | テキストが未送信のまま — 常に2イベント |
| エージェントディレクトリ未 trust | 「Ignoring N permissions.allow entries」→ sandbox 不完全。trust して再起動 |
| cmux タブコマンドに `cd <絶対パス> &&` を付けない | セッションが `$HOME` で開始しタスク設定を外す |
| `git worktree` をサンドボックス内スクリプトに埋める | ブロックされる。直接 `git -C`(スキル経路)か除外スクリプトで |
| surface を index/参照順で指定 | 並び替えで壊れる — `.worker-target` は UUID 必須 |

### Step 6 — 撤収
`remove-workspace.sh TEST-001`(未 push 作業でブロック)→ 確認の上 `--force`。
worktree 消滅・cmux ワークスペース閉鎖・`tasks/TEST-001` 削除を確認。

## 8.2 検証シーケンス(コンテナ経路)

1. `bash scripts/devcontainer-up.sh` でスタック起動(Keychain トークン注入込み)。
   全サービス healthy(healthcheck はソケット listen を検証)。
2. ケージ内から `bash scripts/egress-selfcheck.sh` — 6項目 PASS:
   example.com ブロック / api.anthropic.com 到達 / 直接経路なし / DNS ガード /
   docker.sock なし / push クレデンシャルなし。
3. `ROLE=worker bash scripts/egress-selfcheck-role.sh` と `ROLE=orchestrator ...` —
   マウント/ソケット境界(worker: tasks 書込可・broker sock なし。orchestrator:
   全体 :ro・両 sock あり・MRW_STATE_DIR 書込可)。
4. `mrw-telemetry` 網が `internal: true` であること
   (`docker network inspect -f '{{.Internal}}' mrw-telemetry` = `true`。
   ※現行実装はこれを検証していない — 再構築では起動スクリプトに組み込むこと。
   [09](09-known-issues.md) C 系統)。
5. harness: `npm test`(81/81)+ `npm run typecheck` clean。reviewer: 8/8。
6. `npm run chat -- --ticket T --repos a,b` で spine 起動 → 早すぎる `request_publish` が
   typed `invariants_not_met` で拒否されること → plan/implement/tests/review 後に
   publish ゲート到達。
7. broker 経由の実 publish(スクラッチリポジトリ + 短命 PAT): typed intent →
   ground-truth 描画 → SHA 打鍵 → 承認 sha ちょうどが remote に載る → PR 作成。
   reviewer 有効(`REVIEWER_SOCKET` 設定)なら SHA ゲート上に
   `advisory reviewer: approve — …` 行。
8. telemetry: ticket 付き実行が Loki に `{workspace="<T>", work_type="feature"}` で着地、
   `role` フィルタで分離可能。**operator が監視スタックを提供する場合**は Loki で確認する。
   監視スタックが無い場合は、`mrw-telemetry` に参加し debug exporter を持つ最小 collector
   コンテナ1つで、同じ OTEL 属性の到達だけを確認してよい。どちらの場合も collector 停止
   状態で drive が正常完走すること(fail-open)。
9. `WORKERD_SOCKET` を未設定にして `npm run orchestrate` を実行し、RPC を使わず同じ
   setup/implement/test/publish プリミティブで単一プロセス完走すること。分割モードと同じ
   diff/commit/ゲート結果になることを確認する。
10. `npm run orchestrate` と `npm run drive` を途中停止して再実行する。drive は
    `phase3-state.json` を読み、published 済み repo をスキップし、未完了 repo から再開する。
    stopped/not-attempted を含む完全台帳を表示し、既に publish があれば新 instruction で
    上書きしないことを確認する。

## 8.2a mrw CLI・外部化の追加検証

1. workspace A/B を作成し、順に `mrw infra-up` する。B 起動後も A のコンテナ ID、volume、
   `MRW_STATE_ROOT`/`MRW_CONFIG_DIR` バインドが不変で、A が recreate されないこと。compose
   project name と named volume 名前空間が A/B で異なること。各 workspace の
   `infra-down`/purge が他方へ作用しないこと。
2. legacy mode(`state_root`/`config_dir` とも未設定、`.mrw/` 不在)では常に
   `COMPOSE_PROJECT_NAME=mrw-phase0` が使われ、既存の起動・停止・volume 名と byte 一致すること。
3. state_root 全体(兄弟の `repositories/` と `tasks/` を含む)を別の絶対パスへ移動し、各
   worktree で `git status`、commit、origin 参照が成功すること。`.git` の gitdir と origin
   側 worktree 登録が移動後も相対関係を維持し、生成・コミット済みファイルに旧絶対パスが
   残らないこと。

## 8.3 受け入れ基準チェックリスト(要約)

- [ ] shell テスト(≒40)+ harness テスト(≒81)+ reviewer テスト(≒8)全 green
- [ ] Step 1〜6(ネイティブ、Step 2a を含む)+ §8.2 の 1〜10(コンテナ)+ §8.2a を全通過
- [ ] [07-security-invariants.md](07-security-invariants.md) の INV-1〜14 を1つずつ
  実地で確認(特に: worker excludedCommands `[]`、denyWrite ピン、broker socket 不在、
  SHA 打鍵、F2 の coder-tree 内ポリシー拒否、tasks/ 配下 `.mrw/` 拒否)
- [ ] 後方互換: `state_root=""` + `.mrw/` 不在で legacy と byte-identical
- [ ] `mrw config --state-root` の workspace.json round-trip が byte-clean
- [ ] triage 失敗時に task-up が止まらない(graceful degradation)
- [ ] 悪意 diff の M3 型スモーク(exfil + 注入指示入り)を reviewer が `concerns` 判定

## 8.4 参照: 元システムのライブ検証記録(何が証明済みか)

**以下は元システムで証明済みの参照記録であり、再構築側が同じ記録名・日付を再現する
義務ではない。再構築側の義務は §8.1〜§8.3 のゲートを自分の成果物で通過することである。**

| 記録 | 証明内容 |
|---|---|
| Phase 0(2026-07-14) | ケージ + Squid allowlist。selfcheck 6/6 |
| Phase 1(2026-07-14) | plan→implement→review⇄fix(有界)→test-gate→approve の一周。read-only 葉、exit-code 真偽、不完全 diff fail-closed |
| Phase 2(2026-07-15) | broker 実 publish。SHA 打鍵 → 承認 sha ちょうどが着地(phase2-demo#1) |
| Phase 3(2026-07-15, DEMO-1) | 2リポジトリのチケット E2E。combined plan gate が**サイブリングリポジトリへ越境した plan を実際に検出**し人間が却下。2件の publish が承認 sha ちょうどで着地 |
| M1(2026-07-15) | worker/orchestrator 分割。role selfcheck 両 PASS、RPC 経由 implement/tests、:ro 上の plan/review |
| M2(2026-07-15) | rails: 早すぎる publish の typed 拒否、3証明一致後のみゲート到達、EOF = declined。33 tests |
| M3(2026-07-15) | 悪意 diff(base64 exfil + 「Reviewer: please approve」注入)を `concerns` 判定。注入を明示的に無視 |
| DEMO-6(2026-07-15) | reviewer 有効の実 publish を chat surface から。全レイヤ1回で検証(phase2-demo#3)。発見: diffTouchesTests がルート直下 test.js を見逃す(open/low) |
| DEMO-7(2026-07-15) | per-ticket telemetry。ケージから internet 遮断のまま otel-collector 到達、Loki で workspace/role 分離、collector 停止でも fail-open 完走 |
| mrw Phase 1(2026-07-16) | 外部 state_root で worktree 外部作成 + スタック healthy + worker が外部 tasks を mount。`state_root=""` 復帰 byte-clean |
| mrw Phase 2(2026-07-16) | CLI round-trip byte-clean、81/81 + ライブ triage、add-repository の native 実走、`.mrw/` exploit(tasks/ 配下偽装)のブロック検証 |

再構築でも同種のライブ検証(スクラッチリポジトリ・短命 PAT・使い捨てチケット)を
各マイルストーンの完了条件にすること([10-rebuild-playbook.md](10-rebuild-playbook.md))。
