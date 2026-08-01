# rebuild-doc-fb — rebuild-doc レビューフィードバック

対象: `rebuild-doc/`(2026-07-16 時点、01〜10 + README)。
判断材料は **rebuild-doc 配下の情報のみ**(元実装コードは参照していない)。

## 総合判断

**実現したいこと(コード非参照の独立エージェントによるゼロから再構築)は妥当。
実現方法(仕様パックの構成・2モード・R1〜R9 フェーズゲート・独立レビュー運用)も
概ね妥当で、完成度は高い。** 規範(MUST/never)と根拠の対提示、既知欠陥の正直な記録、
検証ゲートの具体性は、この種の仕様パックとして優れている。

ただし、**このパックの唯一の消費者は「文言に忠実に従う独立エージェント」**である以上、
文言レベルの矛盾・未仕様領域はそのまま再構築の失敗モードになる。以下の指摘は
その観点で「エージェントが詰まる/間違った物を作る」箇所に絞った。

## 指摘一覧(重要度順)

| # | ファイル | 要旨 | 重大度 |
|---|---|---|---|
| 01 | [01-mode-b-invariant-conflicts.md](01-mode-b-invariant-conflicts.md) | モードB の是正方針が INV-6 / §4.10-1 の文言と正面衝突。忠実再現モードA も「INV を1つも手放さない」と両立しない。pre-push の fail-open 範囲も文書間で不一致 | **Blocker(文書修正)** |
| 02 | [02-inv2-egress-wording.md](02-inv2-egress-wording.md) | INV-2「code 書込と egress は決して同居しない・例外なし」が、worker の実態(anthropic + npm への proxy 経由 egress)と矛盾 | **High(文書修正)** |
| 03 | [03-config-dir-pin-gap.md](03-config-dir-pin-gap.md) | workspace モードで実効ポリシー源になる `.mrw/` が worker/orchestrator の denyWrite ピン対象に入っていない(仕様からの新規発見) | **High(設計改善候補)** |
| 04 | [04-parallel-stack-collision.md](04-parallel-stack-collision.md) | 「複数ワークスペース並走」(§6.5)と固定 compose プロジェクト名 `mrw-phase0`・共有 named volumes が両立しない | **Medium-High(設計改善候補)** |
| 05 | [05-rebuild-spec-gaps.md](05-rebuild-spec-gaps.md) | 独立再構築に必要だが未仕様の領域(テンプレ本文、監視スタック、R3 中間トポロジ、ticket-source 契約、doctor のチェック定義ほか) | **Medium(文書追補)** |
| 06 | [06-playbook-verification-improvements.md](06-playbook-verification-improvements.md) | プレイブック・検証の改善候補(人間必須ゲートの明示、トレーサビリティ表、R3 直行オプション、検証カバレッジの穴) | Medium |
| 07 | [07-minor-inconsistencies.md](07-minor-inconsistencies.md) | 小さな不整合・表記(未定義 ID「F9」ほかの凡例欠如、テスト数の記法曖昧、Cyrillic 混入 typo 等) | Low |

## 判断の要点

- **目的の妥当性**: 仕様パックを「ドキュメント品質の実地テスト」として使う発想は健全。
  到達目標を既知欠陥ごと正直に固定し、回避すべき欠陥(A/B/C)を分離した構成も良い。
- **方法の妥当性**: フェーズゲート + 実装/検証の分離 + 独立レビュー必須(10.3)は、
  実績(push ガード迂回のコミット前捕捉)に裏付けられており妥当。
- **最大のリスク**: 07(不変条件)が**成果レベルではなく機構レベル**で書かれている箇所が
  あり、モードB の是正と矛盾する(→ 01)。不変条件は「何が起きてはならないか」で書き、
  機構は 04/05/06 に置くのが是正方向。
