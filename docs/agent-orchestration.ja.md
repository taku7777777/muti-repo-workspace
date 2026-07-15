# レールの上の LLM orchestrator(設計メモ)

**Status: DESIGN、2026-07-15 合意 — 未実装。** [agent-roles.md](agent-roles.md)
(役割とは何か)と [agent-dispatch.md](agent-dispatch.md)(役割間のハンドオフ)の
姉妹編。このメモはコンテナ経路の制御プレーンの進化を定める: Phase 1–3 の
**コード化された harness**(すべての判断がハードコード、LLM は葉)から、判断と
人間との対話を担う **orchestrator LLM** へ — ただしセキュリティ不変条件は
1つも手放さずに。

> 🇬🇧 English: [agent-orchestration.md](agent-orchestration.md)

## 動機

コード化された harness は決定的だが硬直的だ: ゲートは固定の位置で固定の y/N
表現で発火し、人間は途中で舵を切れず(「plan を少し直して」が選択肢にない)、
人間に何を見せるかも判断ではなくハードコードされている。macOS 経路の
orchestrator(対話形式の Claude)は逆のプロファイルを持つ: 柔軟で対話的だが、
シーケンス制御が半信頼の LLM の中に住んでいる。このメモは中間を取る:
**LLM が提案し、小さな coded spine が裁く。**

## 判断の2分類

鍵となる分割(2026-07-15 の議論より):

| 種類 | 例 | 持ち主 |
|---|---|---|
| **ケージ内のフロー判断** | 再計画か続行か。fix を続けるかエスカレーションか。人間に*何を*見せ、*いつどう*確認するか | **orchestrator LLM** — 誤判断のブラスト半径はケージと下記ゲートで有界 |
| **セキュリティに効く遷移** | テストゲートの真実。publish 前の review 必須。有界ループ。publish は型付き intent のみ。人間ゲートはスキップ不可 | **coded spine** — これらは判断ではなく不変条件 |

orchestrator LLM は worker の出力 — 攻撃者の影響下にあるコンテンツ — を読むので、
注入可能なものとして扱う。注入された orchestrator に決してできてはならないのは
「push」ではなく(それは broker が守る)、(a) 品質ゲートのスキップと (b) 人間の
見るものを嘘に加工すること。(a) は spine が閉じ、(b) は broker 側 reviewer と、
権威あるゲートでの broker 自身の ground truth 描画が緩和する。

## アーキテクチャ: 提案 → 検証 → 実行

```
orchestrator LLM(Agent SDK セッション、読み取り専用ツール)
   │  一度に1つ、型付きアクションを提案する。例:
   │  { action: "run_worker", instruction: … }
   │  { action: "run_tests" } { action: "ask_human", question: … }
   │  { action: "request_publish", repo: …, branch: … }
   ▼
coded spine(痩せた harness — プログラム)
   ├─ アクションを遷移規則(下記の不変条件)と照合して検証する
   ├─ 実行する(worker セッションの起動 / テスト実行 / 人間への確認 /
   │  broker への intent 送信) — LLM 自身は何も実行しない
   └─ 型付き結果を orchestrator セッションに返す
```

これは agent-dispatch の原則(「ケージ内の役割は型付き intent を発し、信頼側が
検証して実行する」)をフロー制御に適用したものであり、Claude Code 自身と同じ形
(モデルがツールを選び、harness が permission を強制する)でもある。

## spine が強制する不変条件(コード、交渉不可)

1. **テストの真実は exit code。** `run_tests` は spine が実行し、判定は
   `status === 0`。orchestrator の「テストは通った」という主張はいかなる遷移の
   入力にもならない。
2. **green なテストゲートと、harness が計算した diff への独立 review の両方が
   この実行内で spine に記録されていなければ、publish intent は出せない。**
3. **すべてのループは有界**(fix 回数、worker の再起動、総予算)。使い切りは
   fail-closed であり、「もう1回だけ」は無い。
4. **publish は broker ソケット越しの型付き intent のみ。** orchestrator は
   git/gh コマンドを組み立てられない(そもそも Bash を持たない)。
5. **人間との対話はスキップも代答もできない。** ターミナルは spine が所有し、
   `ask_human` は人間が実際にタイプした内容を返す。broker の sha タイプゲートが
   publish の権威ある承認であり続ける。
6. **遷移規則そのものは、どのケージからも書き換えられない**
   (トポロジ参照 — spine は worker からも orchestrator セッションからも
   書き込めない場所で動く)。

## トポロジ: 4コンテナ + broker 側 reviewer

2026-07-15 決定(Q1: コンテナは分離 — [agent-roles.md](agent-roles.md) の境界
マトリクスで別セルに落ちる。そして分離こそがレールを*実在*させる: 同一コンテナ
なら Bash を持つ worker が spine のコード/状態を改ざんできるが、別コンテナの
worker にはできない)。

| コンテナ | 境界(OS 層) | 中身 |
|---|---|---|
| **orchestrator**(= agent-roles「採用順序」の読み取り専用ジャッジコンテナを拡張したもの) | worktree **:ro**。小さな handoff/メモ領域のみ rw。egress は anthropic のみ。**broker ソケットを保持** | coded spine + orchestrator LLM セッション + PLAN/REVIEW セッション(同じ境界セル → 1プロファイル) |
| **worker** | worktree **rw**。egress は anthropic のみ。**broker ソケットなし** | IMPLEMENT/FIX セッション、テスト実行 |
| **broker** | LLM フリー。トークン保持。ソース/policy/依存はイメージに焼き込み | 型付き intent の検証、ground truth、sha タイプの人間ゲート、push + PR |
| **broker 側 reviewer**(助言) | 書き込みなし。egress は anthropic のみ。入力は broker からのみ | publish リクエストごとに1レビューセッション |

このトポロジから堅牢化が2つ、無償で得られる:

- worker は publish を*依頼する*能力すら失う(ソケットが無い)。
- orchestrator の読み取り専用は `tools`/`disallowedTools`(アプリ層)だけでなく
  **マウント**(OS 層)で強制される — アプリ層は役割の意味論として残す。
  2層ルールの適用(Q3)。

## orchestrator LLM の形態(Q2: SDK + 対話の皮)

決定: **Agent SDK**。対話形式 TUI でもヘッドレス `-p` でもない。

- レールには型付きアクションとインターセプトが必要で、それは SDK のネイティブな
  形(構造化出力、ツール定義、セッション継続)。harness は既に SDK で動いている。
- 対話形式 TUI は *UX として望ましい*(明示的に確認済み)が、そのエージェント
  ループにはレールを敷けない: spine が遷移を検証できず、アプリ内 permission 層は
  このワークスペース自身の計測で fail-open。**Claude Code に harness レベルの
  フック**(外部プログラムが対話セッションの全アクションを検証できる仕組み)が
  生えたら再検討する。
- このトレードオフから持ち越す **UX 要求**: spine は対話体験に近い対話面を
  提供しなければならない — 人間の入力が orchestrator セッションの user turn に
  なり、orchestrator の質問・報告がストリーミングで返るターミナルチャット。
  人間は orchestrator と話す。spine は見えないミドルウェアである。*何を・いつ・
  どう*確認するかは orchestrator の判断(それがこの設計の眼目)、不変条件の
  ゲートで*人間に確認が行われること*は spine の担当。

## broker 側 reviewer(合意済み、3条件 + 1拡張)

1. **broker は LLM フリーのまま。** reviewer は独立コンテナで、broker が足すのは
   タイムアウト付きの型付き1往復(diff を渡し verdict を受け取る)だけ。
2. **助言限定、fail-visible。** verdict は sha タイプゲートで ground truth と
   並べて表示する。reviewer の不在/失敗は「所見なし」と明示して人間が判断する。
   verdict が push を自動化することは決してない。
3. **入力は broker が描画した ground truth のみ。** coder 由来のテキスト
   (PR body 等)を添える場合は未検証ラベルを付けて分離する。
4. *(拡張、合意済み)* 大きな diff はインラインではなく、**broker のみが書き込める
   領域のファイル**(reviewer には ro でマウントされる named volume 等)として
   渡す。必要に応じてこのチャネルを拡張する。

## 既存ロードマップとの関係

このメモは「読み取り専用ジャッジコンテナ」の増分(agent-roles「採用順序」)を
**吸収**する: ジャッジコンテナとは orchestrator コンテナのことである。
推奨ビルド順:

1. spine + PLAN/REVIEW を移した orchestrator コンテナ(worktree :ro、broker
   ソケットをこちらへ移動) — worker コンテナには IMPLEMENT/FIX + テストだけを残す。
2. orchestrator LLM セッション + 型付きアクションのループ + 対話面。
3. broker 側 reviewer。
4. その後、計画通り Phase 4 の egress 堅牢化へ。

## 未解決の論点

- orchestrator と worker コンテナ間のトランスポート: broker ソケットのパターン
  (named volume 上の unix ソケットで型付き要求/応答)の再利用か、macOS 経路の
  ような handoff ファイルプロトコルか。コマンドはソケット + 大きな成果物は
  ファイル、に傾いている。
- worker セッションの寿命: 指示ごとに1 SDK セッションか、常駐 worker プロセスか。
  指示ごとが単純で、今の harness とも一致する。
- 今の `runOrchestrator` のどこまでが spine コードとして生き残るか
  (`gates.ts` / `publish.ts` の大半はそのまま持ち越せるはず)。
- reviewer の独立性の設定: `settingSources: []` と別モデルエイリアスは安価。
  broker 側 reviewer に coder のテスト出力も見せるかどうかは要決定
  (見せない — ground truth のみ、に傾いている)。
