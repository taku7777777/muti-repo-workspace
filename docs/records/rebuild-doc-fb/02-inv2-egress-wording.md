# 02 — INV-2 の文言が worker の実態 egress と矛盾(High: 文書修正)

## 対象箇所

- `07-security-invariants.md` INV-2:
  「code 書込と外部 egress は決して同居しない。…Coder(worker)は internal-only
  ネットワークに留まる。**「この依存の fetch だけ」の例外もなし**」
- `03-architecture.md` §3.6 境界マトリクス: write code × egress read-allowlist = 🚫 禁止
- `05-container-path.md` §5.1 worker / §5.4 allowlist:
  worker は proxy 環境変数経由で `api.anthropic.com`(推論)と
  `registry.npmjs.org`(**npm ci / テストゲート**)に到達できる
- `01-goals-and-scope.md` §1.3: worker は「egress は anthropic のみ」(これも npm と不整合)

## 指摘

コンテナ経路の worker(write:code ロール)は、トポロジ上は `caged`(internal)に
居るが、二重ホームの egress-proxy を介して **read-allowlist の外部 egress を現に持つ**。
しかも allowlist には推論エンドポイントだけでなく `registry.npmjs.org` が含まれ、
その用途は「npm ci / テストゲート」— つまり INV-2 が「例外なし」と明言している
**依存 fetch そのもの**である。

- 文言に忠実な再構築エージェントは、worker から npm 到達を**外す**可能性が高い
  (INV は「1つも緩めない」絶対条件だから)。するとテストゲート(FR-7.1)が
  コールドスタートで動かず、原因究明に無駄なループが生じる。
- 逆に 05 を優先したエージェントは「INV-2 には暗黙の例外がある」と学習し、
  以後の判断で INV の絶対性を割り引くようになる。どちらも有害。

なお §1.3 の「egress は anthropic のみ」も npm を落としており、01/03/05/07 の
4文書で worker egress の記述が3通りに揺れている。

## 本当の不変条件(rebuild-doc 内の設計判断から復元)

05 §5.4 の「意図的に除外」リストの理由付けが実際の境界線を示している:

- github.com 系を許さない理由 =「allowlist は fetch と push を**区別できない**」
  → 禁止すべきは**書込可能・exfil 可能なエンドポイント**。
- sentry.io を永久拒否する理由 =「マルチテナント exfil シンク」→ 同上。

つまり INV-2 の実態は「code 書込ロールには**汎用 egress・書込可能エンドポイント・
exfil シンクを決して与えない**。許されるのは、機能に不可欠な固定インフラ
(推論エンドポイント + パッケージレジストリ)への read-allowlist のみで、
これはタスク都合で拡張しない」である。

## 改善候補(推奨)

1. INV-2 を上記の形に書き換える。「例外なし」の一文は
   「**タスク都合での allowlist 追加は例外なし**(依存が要るからと github や pypi を
   足さない)」に限定し直す。
2. §3.6 マトリクスの 🚫 セルに脚注を付ける:「推論エンドポイント + パッケージ
   レジストリの固定インフラ allowlist は Coder にも許容(本表の egress は
   タスクレベルの外部到達を指す)」。
3. §1.3 の「anthropic のみ」を「anthropic + npm registry(固定 allowlist)」に修正。
4. 許容済み残余リスクとして 07 末尾の「認めた上での限界」に1行追加する:
   「npm registry 経由のケージ内サプライチェーン(悪意パッケージの install script が
   ケージ内で実行されうる)は、ケージ無シークレット + egress 制限により影響半径を
   限定した許容リスク」。sentry の記録と同じ流儀で、将来の再議論を可能にする。
