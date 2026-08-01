# 01 — 目的とスコープ
日付: 2026-07-17(2026-08-02 の §12.1 移行で遡及付与。値はファイルの最終更新時刻 —— 初版コミットは保存と同日のため)

## 1.1 このドキュメント群の目的

`muti-repo-workspace` で構築した実装一式を、**このリポジトリのコードを一切参照できない
独立したエージェントが、ゼロから再構築できる**ようにするための要求仕様・技術仕様パック。

- 再構築エージェントに渡す入力 = この `rebuild-doc/` 一式(+ 公開ツールのドキュメント)。
- 期待する出力 = 動作する同等システム(検証ゲートは [08-verification.md](08-verification.md))。

## 1.2 対象システムの要約

**muti-repo-workspace** — 複数リポジトリを横断して、サンドボックス化されたマルチエージェント
Claude Code セッションを走らせる Git リポジトリ型ワークスペース。

解決する根本問題: エージェンティックコーディングの2つの相反する要求の両立。

- **自由**: コマンドごとの確認プロンプトなしで自律的に動く
- **封じ込め**: push・持ち出し・クレデンシャル読取・自己権限拡大が物理的に不可能

解決原則(全設計の礎):

> **ロール単位でサンドボックスする(コマンド単位ではない)。**
> 危険なことが OS/ネットワークトポロジのレベルで不可能だからこそ、
> エージェントはゼロプロンプトの自律性を得る。
> 境界は必ず OS / ネットワークトポロジで fail-closed に強制する。
> アプリ内権限ルール(Claude Code の permissions)を境界にしてはならない。

## 1.3 システムの3つの柱

| 柱 | 概要 | 実装群 |
|---|---|---|
| **① ネイティブ macOS / cmux 経路** | 1チケット = `tasks/<T>/` + git worktree + サンドボックス化 worker + orchestrator + 人間用 Terminal の cmux 3タブ | `.claude/skills/`(9スキル)、`scripts/`、`templates/`、`.githooks/pre-push` |
| **② コンテナ経路(devcontainer)** | macOS サンドボックスを Linux コンテナ(netns 境界)に置換。5サービス: worker / orchestrator / broker / reviewer / egress-proxy。worker の egress は Anthropic + npm registry の固定 allowlist のみ。「LLM は提案し、コード化された spine が処分する」 | `harness/`、`broker/`、`reviewer/`、`.devcontainer/`、`docker/egress/` |
| **③ mrw CLI(状態の外部化)** | リポジトリ自体がワークスペースであることをやめ、`mrw` バイナリが任意ディレクトリの外部状態(`state_root`、per-workspace `.mrw/`)を操作する | `cli/mrw.mjs`、`scripts/lib/common.sh` の config 解決、triage leaf |

3本柱は歴史的に ① → ② → ③ の順で構築され、②は①の worktree/handoff の資産を再利用し、
③は①②双方の状態参照を外部化する。

## 1.4 再構築のスコープ

### 含む(到達目標 = `feat/mrw` ブランチ相当)

- ネイティブ経路一式(9管理スキル、タスクライフサイクル、サンドボックス設定生成、
  handoff プロトコル、pre-push ガード、cmux 統合)
- コンテナ経路一式(5サービス compose、broker の ground-truth 承認、workerd RPC、
  spine + LLM on rails、advisory reviewer、egress allowlist、per-ticket OTEL telemetry)
- mrw CLI Phase 1〜2(state_root 外部化、`mrw` ディスパッチャ、per-workspace `.mrw/`、
  task-up triage leaf、native 経路パリティ)
- テストスイート(harness 81 / shell 40 / reviewer 8 相当のカバレッジ)
- ドキュメント(architecture / handoff-protocol / settings-reference / verification-guide 相当)

### 含まない(未着手・設計のみ)

- **Thread B**: ブラウザ承認(`mrw serve`)— 設計済み・未実装([06](06-mrw-cli.md) §6.7)
- **Phase 4**: egress の L7/TLS 強化、per-role allowlist の一般化、LLM egress proxy
- **Phase 5**: macOS/cmux レイヤの廃止(コンテナ経路のライブ実証が済むまで実行禁止)
- **Documenter / Researcher / Reporter ロール**と dispatch control plane(`.worker-targets`)
  — 設計のみ([03](03-architecture.md) §3.6)
- per-ticket の `work_type` → telemetry 配線(スタック共有制約で繰延)

### 再構築の2モード

| モード | 内容 |
|---|---|
| **A. 忠実再現** | feat/mrw の実装をそのまま再現。既知の欠陥([09](09-known-issues.md))も当時のまま |
| **B. 改良再構築(推奨)** | 同じ要求・不変条件を満たしつつ、[09](09-known-issues.md) のマージブロッカー3系統(push ガードの config 解決、triage posture、telemetry 網検証)を設計段階から回避 |

どちらのモードでも、[07-security-invariants.md](07-security-invariants.md) の不可侵不変条件は
1つも手放してはならない。

モードA(忠実再現)は、外部 `state_root` を使わない legacy 構成(`state_root` 空・per-workspace
`.mrw/` 不在)に限って忠実再現の対象とする。外部化構成(`state_root` 外部化 / per-workspace
`.mrw/`)を持つ構成の忠実再現は、[09-known-issues.md](09-known-issues.md) が記録する既知欠陥
(pre-push の walk-up が外部化と両立しない等)の再現を含むことを、成果物ドキュメントに
明記すること。

## 1.5 前提環境

- macOS(ネイティブ経路。サンドボックスは Claude Code の macOS サンドボックス。
  `--no-sandbox` モードは他 OS でも動くが境界保証なし)
- Claude Code **≥ 2.1.149**(worker サンドボックスが origin `.git` に書込権を持たずに
  worktree コミットできる挙動に依存 — 検証記録 S8-d)
- `git` `jq` `curl` `gh`(GitHub CLI)、対象リポジトリへの SSH アクセス
- [cmux](https://github.com/wandb/cmux) — 任意だが強く推奨(なければクリップボード
  フォールバックの単一セッションモード)
- コンテナ経路: Docker compose 互換ランタイム(実績は Colima 2CPU/4GiB。Docker Desktop 可)、
  Node 20、`@anthropic-ai/claude-agent-sdk`(実績ピン: 0.3.205)
- 認証: Anthropic は OAuth トークン(`claude setup-token`、macOS Keychain 保管)か
  `ANTHROPIC_API_KEY` のどちらか一方。broker の push は fine-grained PAT を
  ホストシェルで per-run export(保存しない)

## 1.6 読み順

読み順の正典は [README.md](README.md) の「構成と読み順」を参照する。
