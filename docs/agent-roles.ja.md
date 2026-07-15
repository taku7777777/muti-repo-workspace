# エージェント役割の分類(設計メモ)

**ステータス: 設計のみ・未実装。** 本メモは、このワークスペースが今後育てていく
べき役割アーキタイプを定義する。[architecture.md](architecture.md) の
「multi-worker archetypes(coder / reader / researcher / documenter …)は planned
extension」という記述の具体形であり、外部の read と write を分けるために
`researcher`/`reporter` を分割して拡張したもの。ここに書かれたものはまだ何も
実装されていない。コンテナ経路([devcontainer-status.md](devcontainer-status.md))
が役割を増やすとき、各役割を**場当たりでなく境界に対して**配置するために存在する。

> 🇬🇧 English: [agent-roles.md](agent-roles.md)

## 整理の原則

役割とは**細かい権限リストではない**。役割とは**1つの独立した封じ込め境界**であり、
その用途で名付けられる。2つの役割を分ける価値があるのは、下記の境界マトリクスで
**別のセルに落ちるとき、かつそのときだけ**。同じセルに落ちる2つの用途は別役割に
する必要はない(それは細かく割りすぎ)。

このワークスペースで封じ込めを実際に決めているのは2軸だけ。それ以外(どのモデルか、
どの MCP サーバか、プロンプトの文言か)は役割**内の**設定であり、新しい役割を作る
理由にはならない。

| 軸 | 値 | なぜこれが決定的な軸なのか |
|---|---|---|
| **ソース書き込み** | `none` · `docs-only` · `code` | `code` は build/lint/test を意味する = 攻撃者が影響しうるスクリプトからの**任意コード実行**。最も影響範囲が大きい能力。 |
| **外部 egress** | `none` · `read-allowlist` · `write-allowlist` | 境界からデータが出る唯一の経路。read と write の egress は**別の allowlist・別の役割**である — 悪意ある入力を読める役割は誘導されうるので、書き出す手段まで持たせてはならない。 |

**強制ルール(妥協不可):** 各境界は OS/ネットワークトポロジ(ネットワーク名前
空間、マウント、egress-proxy の allowlist)で **fail-closed** に強制する。Claude Code
のアプリ内 permission ルールには**絶対に依存しない**。このワークスペース自身の実測で、
アプリ内層は fail-open(パス限定 `deny` は no-op、Read/Write/WebFetch/MCP/hooks は
sandbox を迂回、local-settings のドリフトで deny が再オープン)と分かっている。粗い
役割が安全なのは、各役割が実 OS 境界で裏打ちされている**からこそ**。アプリ権限で
強制する粗い役割は、役割が無いより悪い。

## 境界マトリクス

|            | egress `none` | egress `read-allowlist` | egress `write-allowlist` |
|---|---|---|---|
| **write `none`**      | — | **Researcher**, **Reviewer** | **Reporter** |
| **write `docs-only`** | **Documenter** | (docs + read 調査、もし必要なら) | — |
| **write `code`**      | **Coder** | 🚫 禁止の組み合わせ | 🚫 禁止の組み合わせ |

2つの 🚫 セルこそが要点:**`code` 書き込みは、いかなる外部 egress とも決して同居
させない。** それらを組み合わせるセルは設計上の危険信号 — 却下するか、egress の
必要は**別の役割** + 人間ゲート経由に回す。

## 役割

各役割は次で定義する: 用途・マトリクスのセル・ツール姿勢・強制する境界・注入時の
ストーリー(この役割が注入されたとき何ができ、何ができないか)。

### Coder
- **用途:** 実装・lint・build・test。ソースを編集する。
- **セル:** write `code` × egress `none`。
- **ツール:** 編集 + Bash(テストランナーを走らせる必要がある)。ネットワーク
  ツールは無し(そもそも使う egress が無い)。
- **境界:** `internal: true` ネットワーク上の caged コンテナ — インターネットへの
  経路ゼロ。まさに現行 harness の coder / macOS の `worker`。
- **注入時のストーリー:** 最も注入されやすい役割(repo を読みそのコードを実行する)、
  ゆえに**最も**厳しく caged。注入されても、自分の worktree は壊せるが、exfil 不可・
  push 不可・いかなる外部サービスにも到達不可。封じ込めは行儀の良さではなく
  ネットワーク境界による。

### Documenter
- **用途:** ソースでないドキュメント、設計の作成、知識の集約。
- **セル:** write `docs-only` × egress `none`(または `anthropic` のみ)。
- **ツール:** 編集は docs/知識サブツリーに限定。文脈のため source は読める。Bash の
  test/build は不要。
- **境界:** 書き込み可能マウントが docs サブツリーだけのコンテナ/uid。source は
  読み取り専用マウント。
- **注入時のストーリー:** source を触れず、実行できず、egress できない。最悪でも
  自分の書き込み可能サブツリー内の質の悪いドキュメント。

### Reviewer
- **用途:** diff/設計の読み取り専用ジャッジ。独立性こそが機能。
- **セル:** write `none` × egress `read-allowlist`(通常は `none` — prompt で渡された
  diff を読む)。
- **ツール:** 読み取り専用。`tools: READ_ONLY_TOOLS` **かつ**
  `disallowedTools: DENY_MUTATION` で強制(bypassPermissions 下では allowlist だけ
  では Edit/Write/Bash が外れない)、さらに `settingSources: []` で悪意ある対象 repo の
  `CLAUDE.md` がジャッジに指示できないようにする。現行 harness の REVIEW ステップ
  そのまま。
- **境界:** Coder とは**別のセッション/インスタンス** — コードを書いた本人とは
  決して同じにしない(独立性)。コンテナ化するなら読み取り専用マウント。
- **注入時のストーリー:** write も egress も無い → 注入された reviewer は verdict で
  嘘をつけるだけ。verdict は人間ゲート + 終了コードのテストゲートへの助言であり、
  単独の決定者には決してならない。

### Researcher
- **用途:** 調査 — Slack、Notion、ソースログ、Datadog、cloud logging。source も外部も
  読み取り専用。
- **セル:** write `none` × egress `read-allowlist`。
- **ツール:** source の read。**読み取り専用**の外部 allowlist(特定ホスト、理想的には
  特定の read API)。編集・push・外部 write は無し。
- **境界:** 必要な read エンドポイントだけを通す専用の egress-proxy allowlist。source は
  読み取り専用マウント。書き込み可能な source マウントは無し。
- **注入時のストーリー:** これがこの分類が持ち込む**新しい攻撃面**。攻撃者が制御する
  Datadog ログ/Notion ページを読む researcher は誘導されうる。それが封じ込められるのは
  **write egress も source write も持たない**から — 騙されても、それを行動に移す
  チャネルが無い。まさにこのために Researcher と Reporter を分ける。

### Reporter
- **用途:** 限られた外部宛先(Slack、Notion)への書き込み/返信。限られた手段、限られた
  リソース。
- **セル:** write `none`(source)× egress `write-allowlist`。
- **ツール:** **宛先ごとに絞った**外部 write allowlist。渡された以上の source read/write は
  不要。
- **境界:** write エンドポイントだけを通す egress-proxy allowlist。Researcher の read 用
  とは**別の** allowlist。
- **注入時のストーリー:** allowlist された宛先に投稿できるだけ、それ以外は不可。影響
  範囲は「望まない Slack/Notion メッセージ」であって任意ホストへの exfil ではない。
  **git push / PR 作成は Reporter の能力ではない** — 不変条件を参照。

## 不変条件(拡張しても安全を保つガードレール)

1. **すべての境界は OS/トポロジ層で fail-closed に強制する**。アプリ内 permission
   ルールにはしない。新しい役割 → 新しい OS 境界(名前空間 / マウント / egress
   allowlist)、さもなくば存在しない。
2. **`code` 書き込みは外部 egress と決して同居しない。** Coder は internal 専用
   ネットワークに留まる。例外なし、「この依存取得のときだけ」も無し。
3. **Reviewer の独立性は構造で担保する**。プロンプトではなく、読み取り専用ツール +
   `settingSources: []` + diff を作った Coder とは*別インスタンス*。
4. **git push / PR / publish はこの5役割のどれでもない。** それはコンテナ外の
   **broker**(専用コンテナ・専用トラスト、唯一のトークン保持、人間ゲート付き、
   fetch した sha から ground truth を再描画)に隔離したまま。Reporter の「外部
   write」は Slack/Notion クラスの宛先だけ。コードの publish は別の、より強くゲート
   された境界。利便性のために統合しないこと。

## egress allowlist — 役割別(雛形)

egress は**役割ごと**に定義し、デフォルトは何も無し(空)。役割が確実に必要とする
ものだけを埋める。proxy はそれ以外を fail-closed で拒否する。

| 役割 | egress allowlist(例示 — 実ホストは config で設定) |
|---|---|
| Coder | *(空 — internal ネットワークのみ)* |
| Documenter | *(空。自身が LLM を駆動する場合のみ `api.anthropic.com`)* |
| Reviewer | *(空。diff は prompt で受け取る)* |
| Researcher | `*.slack.com`(read)· `api.notion.com`(read)· `api.datadoghq.com`(read)· cloud-logging の read エンドポイント |
| Reporter | `slack.com/api/chat.postMessage` · `api.notion.com`(write)— それ以外は無し |

この表の2つのルール: (a) 同じプロダクトの read と write エンドポイント(Slack read と
Slack write)は**別役割**に置く、1つの統合 allowlist にしない。(b) ある役割の
allowlist が**書き込み**のために code ホスト(github.com、パッケージレジストリ)を
必要とするなら、それはこの役割ではなく broker の仕事。

## コンテナトポロジへのマッピング

現行 devcontainer は3コンテナでこのパターンを実証済み: `coder`(caged)、`broker`
(トークン保持)、`egress-proxy`(allowlist)。これらの役割は同じプリミティブに乗る:

- **Coder** = 現行 `coder` サービスそのまま。
- **Documenter / Reviewer** = coder 境界の読み取り専用/docs-only 版(source を `:ro`
  マウント、または docs サブツリーだけ書き込み可能)。Coder と同じ internal 専用
  ネットワーク — egress 無し。
- **Researcher / Reporter** = `egress` ネットワークに正当に触れる最初の役割。それぞれ
  egress-proxy の背後で**自分専用の** allowlist を持つ。push トークンは決して持たない
  (それは broker だけのもの)。
- **Broker** = そのまま。唯一の publisher。

**インスタンス方針(共有 vs 使い捨ての議論より):** 役割は*イメージ/ポリシー*(境界
プロファイル)を定義する。インスタンスは**チケットごとに使い捨て**、チケット間で共有
しない。1つの長寿命コンテナをチケット間で共有すると (a) 全チケットの秘密が1箇所に
蓄積し、(b) タスク分離を fail-open なディレクトリ ACL に押し戻す — どちらも却下。
コストは役割イメージのテンプレート化とインスタンスの使い捨てで抑える。プールでは
抑えない。

**採用順序(2026-07-15 合意):** Phase 2/3 の live 検証後の最初の具体的な増分は
**読み取り専用ジャッジコンテナ** — ソースを `:ro` マウント、egress は
`api.anthropic.com` のみ — で、harness の PLAN と REVIEW ステップをそこで走らせる。
Plan と Review は boundary matrix の*同じ*セル(write `none` × egress anthropic のみ)
に落ちるので、**1つのプロファイルが両方を担う** — ステップごとに分けるのは細かく
割りすぎである。これによりレビューの独立性が、アプリ層のツール制御
(`tools`/`disallowedTools`)から OS 境界に格上げされる。Implement は今の coder
コンテナのまま(セルは不変で、その封じ込めは元々ツール制御に依存していない)。
それ以上の役割分割(Documenter / Researcher / Reporter)は dispatch 制御プレーン
([agent-dispatch.md](agent-dispatch.md))を待つ — コンテナ間ハンドオフが型付きかつ
dispatcher 仲介になる前に、役割を増やしてはならない。

## 未解決の論点 / 次の一手

1. **Reviewer と Researcher の重なり:** どちらも `write:none`。別役割に保つ
   (Reviewer = `settingSources:[]` のコード diff ジャッジ、Researcher = 外部 read)か、
   2 config を持つ1つの読み取り専用役割にするか? 傾き: 別々。egress が違うから
   (Reviewer は none、Researcher は read-allowlist)。
2. **Documenter が Researcher の read egress を必要とするか**(書くために Notion の
   設計ドキュメントを取得する等)? もしそうなら `docs-only × read-allowlist` セル —
   許容だが、Documenter の黙った拡大ではなく、意図的に別 allowlist の役割にする。
3. **役割がどう別役割を呼ぶか?**(例: Coder 完了 → Reviewer がジャッジ → Reporter が
   通知)。`.worker-targets` マップ + spawn/dispatch スキルが必要。architecture.md の
   planned extension 参照。順序制御は役割ではなくディスパッチャが持つ — caged な役割の
   外に出す。詳細設計は [agent-dispatch.md](agent-dispatch.md)。
4. **検証:** これらは何一つ live boot されていない。Researcher/Reporter を採用する前に、
   役割ごとに最小の egress-allowlist テストを足し、proxy が意図したエンドポイント
   だけを通しそれ以外を拒否することを証明する(`scripts/egress-selfcheck.sh` を拡張)。
   設計は [egress-selfcheck-per-role.md](egress-selfcheck-per-role.md)。
