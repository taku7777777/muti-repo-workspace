# 04 — 「複数ワークスペース並走」と固定 compose プロジェクト名の衝突(Medium-High)

## 対象箇所

- `05-container-path.md` §5.0: 「compose プロジェクト名: **`mrw-phase0`**」(固定)、
  named volumes: `broker-sock` / `worker-sock` / `reviewer-sock` / `review-diffs` /
  `spine-notes`
- `06-mrw-cli.md` §6.5: 「**複数ワークスペースが自分のスタックを並走できる**
  (ユーザーのマルチターミナル運用が要件)」
- `02-requirements.md` FR-6.3: 「複数ワークスペースを並走できる」
- `06-mrw-cli.md` §6.8: named volume は運用履歴として既定保持、`mrw close --purge` で明示破棄

## 指摘

FR-6.3 / §6.5 は複数ワークスペースのスタック並走を**要求**として掲げるが、
compose プロジェクト名が `mrw-phase0` 固定である限り、これは成立しない:

1. **コンテナの衝突**: Docker compose はプロジェクト名でコンテナを同定する
   (`mrw-phase0-worker-1` 等)。ワークスペース B から `infra-up` すると、
   ワークスペース A のスタックが「同一プロジェクトの構成変更」として
   **recreate される**(A の `MRW_STATE_ROOT`/`MRW_CONFIG_DIR` バインドが B の値に
   差し替わる)。並走ではなく乗っ取りになる。
2. **named volume の共有**: volume はプロジェクト名で名前空間化されるため、
   固定名では `spine-notes`(ledger!)と `review-diffs` が全ワークスペースで
   共有される。ledger は publish ゲートの証明台帳(INV-9)であり、別ワークスペースの
   チケットと混ざるのはセキュリティ的にも汚染。socket volume の共有は
   「別ワークスペースの broker に intent が届く」誤配線の芽になる。
3. `mrw-telemetry` 網は external + internal の共有設計なので並走時も問題ない
   (ここは現仕様のままでよい)。

パック内に「プロジェクト名をワークスペースごとに変える」記述は存在しないため、
仕様どおり再構築すると FR-6.3 は満たされない。**要求(FR)と実装仕様(05/06)の
ギャップ**であり、どちらかが正しいか明示が必要。

## 改善候補

- **案1(推奨)**: `mrw infra-up` が compose プロジェクト名をワークスペースから
  決定的に導出して `-p` で渡す(例: `mrw-<config_dir の realpath の短ハッシュ>`)。
  named volume・コンテナ・デフォルトネットワークが自動的にワークスペース単位で
  分離される。`mrw close --purge` / `infra-down` も同じ導出を使う。
  `mrw doctor` に「このワークスペースのプロジェクト名と稼働状態」の表示を追加。
- **案2**: 並走要件を「同時に active なスタックは1つ。ワークスペース切替は
  `infra-down` → `infra-up`」に弱める(FR-6.3 と §6.5 を修正)。マルチターミナル
  運用の実態と合わないなら不採用。
- どちらを採るにせよ、`08-verification.md` に並走(または排他)の検証項目が
  現状1つもないので、R8 ゲートに追加すべき:
  「ワークスペース A/B を順に infra-up し、A のコンテナ・volume・バインドが
  B の起動後も不変であること(案1)/ 2つ目の起動が明示拒否されること(案2)」。

## 補足

`05` §5.0 の固定名は Phase 0 時代の名残と推測できる(名前が `mrw-phase0`)。
歴史的経緯を仕様に持ち込んだ結果、後から入った要求(FR-6.3)と矛盾した典型例。
再構築ではプロジェクト名自体も `mrw-phase0` を踏襲する必要はない旨を
05 に注記するとよい。
