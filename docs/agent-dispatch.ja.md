# エージェントディスパッチ — `.worker-targets` コントロールプレーン(設計メモ)

**ステータス: 設計のみ・未実装。** [agent-roles.md](agent-roles.md) の姉妹編。
あのメモが*役割とは何か*を定義するのに対し、本メモは、caged な役割が自分の持たない
能力を得ることなく*ある役割が別の役割へどうハンドオフするか*を定義する。
[architecture.md](architecture.md) の「`.worker-targets` マップ + spawn-worker スキル」
という planned extension の具体形である。

> 🇬🇧 English: [agent-dispatch.md](agent-dispatch.md)

## ディスパッチを安全にする唯一のルール

**ディスパッチャは信頼されたコントロールプレーン。役割は caged な葉(leaf)。**
順序制御 — 「Coder 完了 → Reviewer にジャッジさせる → Reporter に通知させる」 —
はディスパッチャに存在し、**caged な役割の内部には決して存在しない**。caged な役割は
次のことができない:

- *どの*役割を次に走らせるかを選ぶ、
- ターゲットマップを書き換えて、ある役割名を別のサーフェスに向ける、
- 別の役割に生のペイロードを渡し、それがその役割の動作にそのままなる。

もしこれらのいずれかが可能なら、ディスパッチは脱出口になる: プロンプト注入された
Coder(構造上 egress 無し)は、単に *Reporter に依頼*して自分の秘密を投稿させ、
正当に write-egress を持つ役割を通じて exfil できてしまう。**ディスパッチの遷移
それ自体がセキュリティ境界**であり、publish broker とまったく同じように統制する:
型付きの intent、信頼された側での再検証、そして egress へと跨ぐあらゆる遷移への
人間ゲート。

## ツリーに既にある2つの先例

1. **macOS の `.worker-target`(単数)。** /open-task は worker の cmux サーフェスの
   **UUID** を `agents/orchestrator/.claude/skills/.worker-target` にピン留めする。
   orchestrator はそれを読めるが書き換えられず(denyWrite)、メッセージングスクリプトは
   `--workspace`/`--surface` の上書きを拒否する — つまり orchestrator は、実行時の
   prompt が何であれ、*自分の* worker だけを命令できる。ディスパッチはこれを1ターゲット
   から**名前付きマップ**へと一般化し、同じピン留めの規律(信頼された書き手、役割には
   読み取り専用、id ピン留め、上書き不可)を保つ。

2. **harness ドライバ(コード化されたコントロールプレーン)。** `harness/src/multi/driver.ts`
   は既に1つのフローのディスパッチャである: 全 repo を計画し、統合された人間ゲートを
   取り、各 repo を Phase-1 パイプラインに順次通し、publish を broker に委ねる。決定性は
   コード化されたフローから来る。LLM のステップは葉であり、決定者は型付き verdict・
   テストゲートの終了コード・人間ゲートだけ。マルチ役割ディスパッチは**同じ形**であり、
   「N repo・1役割(coder)」から「1チケット・複数役割」へと広げたもの。

## `.worker-targets` — マップ

信頼された側のファイル(タスク作成者が書き、あらゆる役割には読み取り専用)で、
**役割名**を具体的でピン留めされたサーフェス/コンテナに解決する — 役割が別所へ
向けられる自由形式のアドレスには決してしない。

```jsonc
// tasks/<TICKET>/.worker-targets  (illustrative)
{
  "coder":      { "kind": "container", "id": "<container-uuid>", "boundary": "caged-internal" },
  "reviewer":   { "kind": "container", "id": "<container-uuid>", "boundary": "readonly-internal" },
  "documenter": { "kind": "container", "id": "<container-uuid>", "boundary": "docs-only-internal" },
  "researcher": { "kind": "container", "id": "<container-uuid>", "boundary": "egress-read" },
  "reporter":   { "kind": "container", "id": "<container-uuid>", "boundary": "egress-write" }
}
```

ピン留めの規律(`.worker-target` からそのまま引き継ぐ): id は不透明で作成時に割り当てる。
このファイルはあらゆる役割に対して denyWrite。ディスパッチ/メッセージング層は呼び出し元が
指定するターゲットの上書きを一切拒否し、ターゲットは**このマップに対して役割名でのみ**
解決する。役割はサーフェスを名指ししない、役割だけを名指しする。名前→サーフェスの
束縛はディスパッチャが所有する。

## 遷移 allowlist(ディスパッチマトリクス)

どの役割もあらゆる他の役割へハンドオフできるわけではない。許される遷移は固定された
信頼された側のマトリクスであり、ディスパッチャがそれを強制する。例示のデフォルト:

| from → to | Reviewer | Documenter | Researcher | Reporter | broker (publish) |
|---|---|---|---|---|---|
| **Coder** | ✅ typed diff | ✅ typed notes | ➖ via dispatcher only | 🚫 (see below) | 🔒 human-gated |
| **Researcher** | ➖ | ✅ findings | — | 🔒 human-gated | 🚫 |
| **Reviewer** | — | ➖ | ➖ | 🚫 | 🔒 human-gated |
| **Documenter** | ➖ | — | ➖ | 🔒 human-gated | 🚫 |

- ✅ = 許可、かつハンドオフは**型付き intent**(スキーマ検証済みオブジェクト)であり、
  自由形式のコンテンツではない。
- 🔒 = **人間ゲート + 信頼された側での再検証**を通じてのみ許可 — no-egress 役割から
  egress 役割への遷移(…→Reporter)や publication への遷移(…→broker)はすべて、
  publish broker と同様に扱う: 受け手側は検証済みフィールドにのみ基づいて動作し、
  人間が承認する。
- 🚫 = 禁止。とりわけ **Coder→Reporter の直接は禁止**: それはまさに exfil 経路
  (caged 役割 → egress 役割)。正当な「コード作業が通知に値するものを生んだ」場合は
  Coder→dispatcher→(人間ゲート)→Reporter と流れ、ディスパッチャが Coder のバイトを
  通すのではなく ground truth から通知を再導出する。
- ➖ = ディスパッチャのみが起点となる(役割が自ら要求することはできない)。

## ペイロードの規律

ハンドオフは**型付き intent** を運び、生のパススルーコンテンツは決して運ばない。これは
broker と同じ教訓である(broker は coder のバイトを信じるのではなく、fetch した sha から
diff を再描画する):

- Coder→Reviewer は `{ repoDir, plan, diff-is-computed-by-harness }` を渡す — diff は
  harness が計算し、Coder は供給しない(`steps.ts` に既にある reviewer-blinding ガード)。
- Anything→Reporter は型付きの `{ template, fields }` を渡し、Reporter(または代理の
  ディスパッチャ)が allow-list されたテンプレートからメッセージを描画する — 役割は
  任意の送信本文を指示できない。これにより、上流の役割が侵害されても Reporter の egress を
  汎用 exfil チャネルに変えられなくなる。

## ディスパッチャはどこで走るか

**信頼された側、あらゆる caged 境界の外** — broker と同じ側。具体的には、コンテナ
トポロジにおいては driver/broker と並ぶプロセス(専用コンテナ、またはホスト側の
コントローラ)であり、役割からは型付きソケット経由でのみ到達可能(coder が broker に
到達するのと同じ)で、役割がディスパッチャの権限を保持することは決してない。それは
次を保持する:

- `.worker-targets` マップ(権威ある名前→サーフェスの束縛)、
- 遷移マトリクス、
- 🔒 遷移のための人間ゲート。

macOS 経路の類似物は orchestrator である — ただし orchestrator は今日のところ
*半信頼*にすぎない(C-3 の `$(...)` エスケープ)。真のディスパッチャは、本当に信頼された
プレーン(`excludedCommands` のパススルー無し)であるべきで、コンテナトポロジはそれを
無償で与える(Linux netns 境界により `$(...)` に脱出先が無くなる)。

## fail-closed の不変条件

1. **役割は役割を名指しし、サーフェスは決して名指ししない。** ターゲット解決は
   ディスパッチャ専用で、denyWrite のマップに対して行う。呼び出し元指定の上書きは拒否する。
2. **遷移マトリクスは信頼された側にあり固定。** 役割は自身の許された
   ハンドオフを広げられない。
3. **すべての no-egress → egress 遷移は型付き intent + 人間ゲート**であり、信頼された
   側で再検証する。egress 役割への生コンテンツのパススルーは無し。
4. **publication は broker のもの**であり続け、汎用のディスパッチ遷移ではない —
   agent-roles.md の不変条件 4 を参照。
5. **ディスパッチャは caged な役割ではなく**、いかなる caged な役割もその権限を保持しない。

## 未解決の論点 / 次の一手

1. **宣言的フロー vs コード化ドライバ。** 順序制御を手書きの TS(`driver.ts` のように
   最大限の決定性)として保つか、フローを宣言的に(用途ごとのフローファイルで)表現するか?
   傾き: コード化。harness が takt を却下したのと同じ理由。
2. **トランスポート。** broker の型付き unix ソケットパターン(名前付きボリューム、macOS の
   Docker Desktop 上では境界を跨ぐ)をすべての役割ハンドオフで再利用するか、それとも
   ディスパッチャ仲介のメッセージバスか? 信頼された側のエッジごとに1ソケットにすれば、
   caged な役割はディスパッチャに*外向き*に到達するだけで、互いには決して到達しない。
3. **Reporter 用のテンプレートレジストリ。** allow-list された送信テンプレートはどこに
   置くか(broker が所有するファイル、`broker-policy.json` のような)? それらは信頼された
   側になければならず、coder が書き込めるツリーには決して置かない。
4. **検証。** (a) caged な役割が到達を許されていないターゲットを解決/上書きできないこと、
   (b) Coder→Reporter の直接試行が拒否されることを証明するテストを足す — マルチ役割
   フローを live boot する前に。[egress-selfcheck-per-role.md](egress-selfcheck-per-role.md)
   の役割別 egress チェックと対になる。
