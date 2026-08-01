# rebuild-doc — 再構築仕様パック

`muti-repo-workspace`(サンドボックス化マルチエージェント Claude Code ワークスペース +
コンテナ経路 + mrw CLI)を、**このリポジトリのコードを参照できない独立エージェントが
ゼロから再構築する**ための要求仕様・技術仕様の一式。

2026-07-16 時点の `feat/mrw` ブランチ(mrw Phase 1〜2 完了、Thread B 未着手)を
到達目標として記述している。以後の作業ツリーで修正済みとなった既知欠陥は
`09-known-issues.md` の日付付き ✅ 注記で追跡する。

`muti-repo-workspace` の `muti` は既存リポジトリの意図的な名称であり、`multi` の誤字ではない。
ID 凡例: F1〜F6 は broker/publish 要求、F9 は別系列のレビュー指摘
(excludedCommands 連結穴)、C-/S-/P- は元リポジトリのレビュー・検証記録の項番であり、
本パックでは出典表示のみを意味する。

## 構成と読み順

| # | ファイル | 内容 |
|---|---|---|
| 01 | [01-goals-and-scope.md](01-goals-and-scope.md) | 目的・3本柱・スコープ(含む/含まない)・再構築2モード・前提環境 |
| 02 | [02-requirements.md](02-requirements.md) | 要求仕様(FR 機能 / NFR 非機能 / SEC セキュリティ) |
| 03 | [03-architecture.md](03-architecture.md) | 設計原則・レイヤモデル・特権マトリクス・マイルストーン構成 |
| 04 | [04-native-path.md](04-native-path.md) | ネイティブ macOS/cmux 経路の実装仕様(スキル・スクリプト・テンプレート・サンドボックス・handoff・pre-push・cmux) |
| 05 | [05-container-path.md](05-container-path.md) | コンテナ経路の実装仕様(5サービス・broker F1〜F6・spine/workerd・egress・認証・テスト) |
| 06 | [06-mrw-cli.md](06-mrw-cli.md) | mrw CLI・state_root 外部化・per-workspace config・triage leaf・Thread B 設計 |
| 07 | [07-security-invariants.md](07-security-invariants.md) | 不可侵のセキュリティ不変条件 INV-1〜14(根拠つき) |
| 08 | [08-verification.md](08-verification.md) | 検証シーケンス・受け入れ基準・元システムのライブ検証記録 |
| 09 | [09-known-issues.md](09-known-issues.md) | 既知の欠陥(マージブロッカー3系統ほか)・再導入禁止の落とし穴・繰延事項 |
| 10 | [10-rebuild-playbook.md](10-rebuild-playbook.md) | 再構築エージェントの運転方法(フェーズ R1〜R9・完了ゲート・プロンプト雛形) |

- **再構築を依頼する側**: 01 → 10 を読み、10 のプロンプト雛形でエージェントを起動する。
- **再構築するエージェント**: 01 → 02 → 03 → 07 を先に読み、実装フェーズごとに
  04/05/06 の該当節と 08 のゲート、09 の該当注意を参照する。

## このパックの位置づけ

- 元リポジトリの `docs/`(architecture / handoff-protocol / settings-reference /
  verification-guide / devcontainer-* / mrw-cli)と実装・レビュー記録から蒸留した
  自己完結版。再構築に必要な規範(MUST/never/always)・プロトコル・検証手順を含む。
- 逆に、チュートリアルや利用者向けガイドではない(それは成果物側の README の仕事)。
- 既知の欠陥を含む「実態」を正直に記録している。改良再構築モードでは 09 の
  ブロッカー3系統を設計段階から回避すること。
