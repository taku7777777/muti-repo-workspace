# ブラウザ承認(`mrw serve`)

**Status: BUILT。** [mrw-cli.md](mrw-cli.md)(「Thread B」設計メモ——本ドキュメント
が実装する決定事項そのもの)と [agent-orchestration.md](agent-orchestration.md)
(broker の SHA タイプ人間ゲート——本機能はこれを、既存の TTY プロンプトの
*代わりではなく、それと並行して*ブラウザにレンダリングする)の姉妹編。

> 🇬🇧 English: [browser-approval.md](browser-approval.md)

## 動機

Phase 2 publish broker の SHA タイプ承認は、この設計全体における**唯一の
権威ある人間ゲート**である: broker は git オブジェクトから構築した
ground-truth なサマリー(coder の言葉ではなく)——push target、full diff、
advisory reviewer の verdict——を自分自身のコンテナの TTY にレンダリングし、
人間が**正確な short sha をタイプした**場合にのみ push が実行される。
反射的な `y` では足りない。これは意図的にボタンより手間がかかる: SHA を
タイプすることが、人間が*その特定のコミット*を見たことを証明する。

とはいえ、生のターミナルは大きな複数ファイル diff には貧弱な媒体だ——
シンタックス構造もなく、折りたたみ可能なファイルツリーもなく、
「3 / 12 files viewed」の進捗表示もない。`mrw serve` は**まったく同じ
ground-truth なビュー**を GitHub の PR のような Web ページとして
レンダリングする(Commits タブ、本物の diff ビューアーを備えた
Files-changed タブ、unified/split モード、単語単位のハイライト)。
その一方で承認行為そのものは変えない: **依然として short sha を
タイプする**、今度はターミナルではなくページへ。broker はレンダリング層を
やはり信頼しない——下記の[信頼モデル](#信頼モデル-侵害された-serve-にできることできないこと)
を参照。

`mrw serve` は**デフォルトで OFF**(compose の `profiles: ["serve"]`)で
あり、**独立した、トークンを持たないプロセス**である——`BROKER_GITHUB_TOKEN`
を決して保持せず、単独では push できない。レンダリングと中継のみを行う。

## アーキテクチャ

```
┌───────────┐   HTTP, localhost のみ          ┌────────────┐   unix socket           ┌────────────┐
│  Browser  │ ──────────────────────────────▶│  mrw serve │ ───────────────────────▶│   broker   │
│ (あなた)  │  session token + CSRF + Host    │ (トークン  │  approve-sock(NEW な    │ (GitHub    │
│           │  header チェック                │  なし)     │  named volume——coder    │  token を   │
└───────────┘ ◀────────────────────────────── └────────────┘  側が既に使う           │  保持)     │
      ▲             GET /api/state をポーリング       ▲       publish.sock ではない)  └─────┬──────┘
      │                                                │                                    │
      │        short sha をページにタイプする           └── broker が、送信された sha を    │ 承認されれば
      │        (承認行為そのものは不変)                    IN-PROCESS で、実際に pending   │ push
      └─────────────────────────────────────────────────── な publish に対して再検証    ▼
                                                             してから push する——詳細は  github.com
                                                             下記                        (または設定した
                                                                                          allowed_push_hosts)
```

- **ホストポートが必要な理由(トポロジー)**: named-volume の unix socket は
  macOS ホストへ到達しない(`.devcontainer/docker-compose.yml` 全体で
  `broker-sock` / `worker-sock` / `reviewer-sock` について文書化されている
  のと同じ Docker Desktop の制約)ので、ブラウザは socket に直接
  ダイヤルできない。代わりに `serve` は `127.0.0.1:<port>` をホストに
  公開する compose service であり、ブラウザは HTTP で `serve` と話し、
  `serve` は新しい `approve-sock` named volume 経由で socket プロトコルを
  broker と話す。
- **TTY ゲートは不変であり、socket と競争する。** `BROKER_APPROVAL_SOCKET`
  が未設定なら broker は Thread B 以前とバイト単位で同一である。
  設定されている場合(現在の `docker-compose.yml` ではデフォルトで
  設定される——下記の[セキュリティ不変条件](#セキュリティ不変条件)を参照)、
  broker の `ApprovalHub` は TTY プロンプトを開始*しつつ*、同時に socket
  経由の決定も受け付ける。どちらかのチャンネルが先に決定した方が勝ち、
  もう一方はキャンセルされる(中断された TTY は、決定がブラウザから
  来た旨を1行だけ出力する)。つまりブラウザ承認フローは**加算的**
  である: `serve` が落ちていても、設定ミスがあっても、単にターミナルを
  好むだけでも、いつでも `docker compose attach broker` にフォール
  バックできる。
- **socket プロトコル(v1)** は3つの JSON op で、1接続につき1つ、
  改行区切り(`publish.sock` と同じフレーミングの精神):
  - `status` — `serve` がこれをポーリングして、現在 pending の publish
    (TTY のヘッダーが既にレンダリングしている全フィールドに加えて
    `shortSha` と `ticket` を運ぶ `Pending` オブジェクト)と、直近の
    決定の outcome を知る。
  - `approve` — pending publish の id とタイプされた sha を運ぶ。broker
    はそれを**自分自身が**保持している in-memory の pending view と
    比較する——`serve` が主張する何かではない——そして完全一致した
    場合にのみ APPROVE を確定する。不一致は3回の試行予算を1つ減らし、
    使い果たすと自動的に DECLINE となる。
  - `decline` — 指定された pending id を DECLINE として確定する。
  - 失敗時にはすべてのレスポンスに `code`(`no_pending`、`stale`、
    `sha_mismatch`、`attempts_exhausted`、`invalid_request`)が付くので、
    `serve` は汎用エラーではなく正確な状態をレンダリングできる。
- **`serve` はこのワイヤースキーマを zod でローカルに再宣言する**——
  broker のソースは import しない。既存の `broker/src/reviewer.ts` と
  `reviewer/src/types.ts` の分割と同じ、別パッケージである理由による。

## 信頼モデル: 侵害された `serve` にできること・できないこと

設計メモ自身の指示——これを取り繕わないこと——に従い正直に述べる:
**ブラウザ向けの HTTP プロセスは攻撃対象領域である**。この節は最悪の
ケース——`serve` のプロセス、コンテナ、あるいはページ自体が完全に
侵害されている(悪意あるコード実行、session token を持つ敵対的な
アクター、何でも)——を想定し、それによって攻撃者が何を得るかを問う。

**できること:**
- **既にpending 中の、正確に1つの sha**を、**同じ allowlist で検証済みの
  target**(host/org/repo/branch)へ自動承認すること。*別の* sha、
  *別の* repo、*別の* org を選ぶことはできない——broker の
  `ApprovalHub.submitApprove(id, sha)` は、broker 自身が git オブジェクト
  から解決して構築した**自分自身の** in-memory `Pending` view と比較する。
  `serve` は文字列を1つ渡すだけで、broker が鵜呑みにする決定を渡すのでは
  ない。
- あるべきでない承認を declined すること(ブラウザチャンネルのみへの
  denial-of-service——TTY ゲートは引き続き機能するので、これは publish を
  完全にブロックすることはできず、単に迷惑をかけるだけ)。
- **既に pending 中**のどの publish についても、その ground-truth な
  ビュー(diff、PR body、reviewer verdict)を読むこと——これはもともと
  ゲートで人間の目に触れる予定だった情報であり、それまで秘密だった
  わけではない。

**構造的にできないこと:**
- **自分で何かを push すること。** `serve` は `BROKER_GITHUB_TOKEN` を
  決して保持しない——その資格情報は broker 自身のコンテナ env にのみ
  存在する(`.devcontainer/docker-compose.yml` の `broker` service を
  参照)。`serve` の `docker-compose.yml` service ブロックには GitHub
  資格情報も `git` も `gh` も一切ない。
- **実際に pending 中のものではない sha を承認する**こと、または
  pending な publish を何もないところから捏造すること——broker の
  再検証は IN-PROCESS かつ同期的であり、`serve` が報告してくる何かでは
  なく、自分自身の状態を読む。
- **worktree や broker の policy を改ざんする**こと。`serve` には
  workspace mount も、`state_root`(`tasks/`/`repositories/`)mount も
  一切与えられていない——approval socket と、自身の読み取り専用な
  cosmetic config 以外、読むものも書くものもない。
- **operator が組み込んでいない任意コードを実行する**こと。`serve` の
  唯一の runtime 依存は `zod` であり、それと TypeScript ソースの両方が
  `docker build` 時にイメージへ焼き込まれる(`.devcontainer/serve.Dockerfile`)
  ——coder が書き込み可能な workspace tree が書けるものは、稼働中の
  `serve` コンテナに一切影響しない。`serve` が実行する内容を変えるには
  イメージの再ビルド、つまり信頼された、人間が起点となる瞬間が必要
  (`broker`/`reviewer` と同じサプライチェーン姿勢)。
- **何か本物の能力でインターネットに到達する**こと。`serve` は自分専用の
  `approve` bridge network(次節参照)上にあり、zod のみの焼き込み依存と
  秘密情報ゼロという構成——このネットワーク自体のトレードオフの正直な
  説明は[セキュリティ不変条件](#セキュリティ不変条件)を参照。

**すべての緩和策(一覧):**

| # | 緩和策 | 場所 |
|---|---|---|
| 1 | トークンなし——`BROKER_GITHUB_TOKEN` を決して保持しない | `serve` の compose env に GitHub 資格情報は一切ない |
| 2 | workspace/state mount なし | `serve` の compose volumes: `approve-sock` + 読み取り専用の cosmetic config bind のみ |
| 3 | zod のみの runtime 依存、build 時に焼き込み | `.devcontainer/serve.Dockerfile` |
| 4 | localhost のみの bind + セッションごとの token + CSRF header + Host header allowlist | `serve` 自身の HTTP レイヤー(下記[セキュリティ不変条件](#セキュリティ不変条件)) |
| 5 | broker が push 前に、送信された sha を IN-PROCESS で再検証 | `broker/src/gate.ts` の `ApprovalHub` |
| 6 | TTY ゲートは不変、socket と競争し、先に決定した方が勝つ | `broker/src/gate.ts` / `broker/src/approve.ts` |
| 7 | profile-gated、デフォルト OFF | `docker-compose.yml` の `profiles: ["serve"]` |
| 8 | `approve-sock` は正確に2つの service にのみマウント | 下記[セキュリティ不変条件](#セキュリティ不変条件) |

## セットアップ

前提条件: devcontainer スタックが起動していること(`mrw infra-up`)。
できれば `broker` も既に起動していること(そうでなくても `mrw serve up`
は起動して警告するだけで済む——ページは `mrw infra-up` を実行するまで
明確な「broker unreachable」状態を表示する)。

```
mrw serve            # mrw serve up と同じ
```

これは以下を行う:
1. アクティブな `config_dir` を解決し(`mrw` が常に使うのと同じ発見順序
   ——`$MRW_CONFIG_DIR`、なければ最も近い祖先の `.mrw/`、なければ
   `<toolHome>/config`)、そこに `serve.json` があれば `port` を読む。
2. `--port N` を渡していれば、その上に適用する。
3. 新しい session token を発行する(`crypto.randomBytes(32)`、64桁の
   16進数——この機能自身の env contract が要求する最小値を大きく
   上回る)——`mrw serve up` を実行するたび**新しい** token であり、
   実行をまたいで何も永続化されない。
4. `docker compose --profile serve up -d --no-deps serve` を実行する——
   `--no-deps` により、稼働中の `broker`(生きた `BROKER_GITHUB_TOKEN` を
   保持しているシェルで、再実行したくないかもしれない)が副作用として
   再作成されることはない。
5. `http://localhost:<port>/?token=<token>` を出力し、macOS では
   `--no-open` を渡さない限りデフォルトのブラウザで開く。

```
mrw serve down        # 停止する
mrw serve status       # docker compose ps serve
mrw serve url          # タブを見失った? トークン付き URL を再出力する
```

**初回起動前のカスタマイズ**(すべてのフィールドは下記の
[カスタマイズリファレンス](#カスタマイズリファレンス)を参照): 
`config/serve.json`(workspace mode では `<config_dir>/serve.json` ——
`mrw init` が雛形をコピーする)を編集して port/theme/title/accentColor/
diff のデフォルトを設定し、その隣に `serve.css` を置けば完全な
cosmetic コントロールが可能。どちらもコンテナ起動時に新しく読まれる
——config だけの変更に再ビルドは不要で、`mrw serve down && mrw serve up`
で反映される(イメージの再ビルドが必要なのは*コード*が変わった場合のみ)。

## UI ガイド

ページには3つの状態がある:

- **idle** ——「Waiting for a publish request…」、workspace/ticket
  ラベル、接続インジケーター(緑 = broker に到達可能、赤 = broker
  unreachable——[トラブルシューティング](#トラブルシューティング)参照)。
- **review** —— pending な publish が決定を待っている。GitHub の PR に
  似たレイアウト:
  - Sticky header: title、`org/targetRepo ← branch`、コピー可能な mono
    な sha chip、commit 数、`+A −D`、advisory-reviewer バッジ(緑
    チェック / オレンジ警告 / グレーの「unavailable」/ 機能 OFF 時は
    非表示)、該当する場合は ticket chip。
  - **Overview** タブ: push-target カード(`will push <sha> →
    refs/heads/<branch>`)、PR body(小さく安全な markdown サブセットで
    レンダリング——見出し、太字/斜体、code、リスト、blockquote、
    `http(s)://` に限定されたリンク)、reviewer のノート。
  - **Commits** タブ: commit ごとに1行、short-sha chip + subject。
  - **Files changed** タブ: 折りたたみ可能なファイルツリーサイドバー
    (フィルター可能、クリックでスクロール)、コピー ボタンと「viewed」
    チェックボックス(ブラウザの `localStorage` に永続化、
    「3 / 12 files viewed」の進捗ピルを駆動し、チェックすると GitHub の
    ように自動折りたたみ)を備えたファイルごとのカード、unified または
    side-by-side の diff 本体(変更されたスパンに単語単位の
    ハイライト)、wrap トグル、"Load diff" ボタンの背後に折りたたまれる
    大きいファイル。キーボード: `j`/`k` で次/前のファイル、`v` で
    viewed をトグル。
  - Sticky **承認フッター**: プレースホルダー `type <shortSha> to
    approve` の入力欄——タイプした内容が一致するまで Approve ボタンは
    無効のまま(これは純粋な UX であり、broker はいずれにせよ再検証
    する)、残り試行回数が3回未満になると警告、確認ステップ付きの
    Decline ボタン。
- **decided** —— outcome バナー(approved / declined / canceled、
  どのチャンネルが決定したか)。承認後は push 結果が届くまで
  「pushing…」、その後 PR リンクまたはエラーテキスト。その下に
  直近の outcome の短いセッション履歴。

Theme: `localStorage` に永続化される、目に見える light/dark/auto
トグル。初回訪問時は `serve.json` の `theme` をデフォルトとし、
それ以外では `prefers-color-scheme` に従う。

## カスタマイズリファレンス

`<config_dir>/serve.json`(このチェックアウトのデフォルトは
`config/serve.json` ——出荷時のデフォルトと、すべてのフィールドに
インラインの `_note` ドキュメントが付いたものは
[`../config/serve.json`](../config/serve.json) を参照)。**すべての
フィールドはオプション**であり、未知のキーは警告付きで無視され、
不正な値は警告付きで組み込みデフォルトに置き換えられる——`serve` は
このファイルを理由に起動を拒否することは決してない。

| フィールド | デフォルト | 意味 |
|---|---|---|
| `port` | `7787` | `mrw serve up` がデフォルトでバインドする公開ホストポート。`--port N` で1回だけ上書き可能。 |
| `theme` | `"auto"` | 初期テーマ(`"auto"` \| `"light"` \| `"dark"`);初回訪問後はページ自身のトグル(`localStorage`)が常に優先。 |
| `title` | `"mrw approval"` | ページの `<title>` とヘッダーテキスト。 |
| `accentColor` | `"#0969da"` | CSS カスタムプロパティ `--accent` として注入される。 |
| `pollIntervalMs` | `2000` | ページが `GET /api/state` をポーリングする間隔。 |
| `diff.view` | `"unified"` | diff レイアウトの初期デフォルト(`"unified"` または `"split"`(横並び))。 |
| `diff.wrap` | `false` | 長い diff 行を水平スクロールの代わりにソフトラップする。 |
| `diff.tabSize` | `8` | diff 本体でタブ文字が占める列数。 |
| `diff.collapseThresholdLines` | `400` | これより diff の変更行数が多い(または 100 KB を超える)ファイルは "Load diff" の背後に折りたたまれて表示される。 |
| `diff.intralineHighlight` | `true` | 対になった +/- 行内の変更されたスパンの単語単位ハイライト。 |
| `sections.body` | `true` | Overview タブに PR body を表示する。 |
| `sections.commits` | `true` | Commits タブを表示する。 |
| `sections.reviewer` | `true` | advisory-reviewer verdict カードを表示する。 |
| `sections.fileTree` | `true` | 折りたたみ可能なファイルツリーサイドバーを表示する(OFF ⇒ フラットなファイル一覧)。 |
| `customCss` | `true` | true **かつ** `<config_dir>/serve.css` が存在する場合、それを `/assets/custom.css` として提供し、**最後に**(組み込みスタイルシートの後に)読み込む。 |

**CSS 変数サーフェス** —— `serve.css` は最後に読み込まれるため、これらを
上書きすれば組み込みルールと戦うことなくページ全体を再テーマできる。
正式で権威ある一覧はパッケージ自身の `app.css`(`serve/src` ——この
一覧とコードが将来乖離した場合はそのコメントを正とすること)の先頭に
文書化されている。本機能の仕様として定められている安定したサーフェスは
以下の通り:

```css
:root {
  --bg: ...;         /* ページ背景 */
  --fg: ...;         /* 主要テキスト */
  --muted: ...;       /* 副次テキスト */
  --border: ...;      /* 罫線、区切り線 */
  --accent: ...;       /* リンク、ボタン、フォーカスリング —— serve.json の accentColor 経由でも上書き可能 */
  --add-bg: ...;       /* diff: 追加行の背景 */
  --add-fg: ...;       /* diff: 追加行のテキスト/マーカー */
  --del-bg: ...;       /* diff: 削除行の背景 */
  --del-fg: ...;       /* diff: 削除行のテキスト/マーカー */
  --chip-bg: ...;       /* sha chip、バッジ */
  /* …完全かつ最新の一覧は serve/src の app.css 冒頭のコメントを参照 */
}
```

light/dark 両方の値が定義されている(組み込みスタイルシートに
`'unsafe-inline'` への依存はない——すべて `/assets/app.css` /
`/assets/custom.css` に存在し、インラインの `<style>` は決してない、
ページの CSP による)。

## セキュリティ不変条件

これらは本機能が決して後退させてはならない性質であり、それぞれが
どこで強制されているかを示す:

- **`approve-sock` は正確に2つの service ——`broker` と `serve`——にのみ
  マウントされる。** これは `.devcontainer/docker-compose.yml` の構成上
  そう保証されている(`approve-sock` を検索すると、その2つの service の
  `volumes:` にしか現れない)。`broker` service のボリュームエントリと
  トップレベルの `volumes:` 宣言の両方に `CRITICAL INVARIANT` コメントが
  ある。`worker`、`orchestrator`、`reviewer` に**決して**このボリュームを
  追加しないこと: これらのケージはいずれも既に自分自身の pending な
  commit sha を知っており、その上でこの socket まで保持すると自分自身の
  publish を自己承認できてしまう——SHA タイプの人間ゲート全体の要点は、
  変更を提案する側が、それを確認する側を兼ねることができない、という
  点にある。
- **`/healthz` 以外のすべてのルートは有効な session cookie を要求する**
  ——bootstrap URL(`/?token=<t>` → `Set-Cookie: mrw_serve=…; HttpOnly;
  SameSite=Strict`)上での timing-safe な token 比較によってのみ
  設定される。
- **すべての POST はさらに**、同じ allowlist に含まれる `Origin` header
  と、session token から導出された `x-mrw-csrf` header を要求する
  ——これは boot payload 経由でのみページに渡され、URL だけから
  推測することはできない。
- **Host header allowlist**(`localhost`、`127.0.0.1`、`[::1]`、任意の
  ポート)がすべてのリクエストに適用される——DNS リバインディングを
  塞ぐ: オープンなインターネット上の敵対的なページが、
  攻撃者が制御するドメインを `127.0.0.1` に解決させることであなたの
  ブラウザを `serve` に向けさせることはできない。TCP 接続がどこに
  着地したかだけでなく、`Host` header 自体がチェックされるからだ。
- **`SERVE_SESSION_TOKEN` は IN-PROCESS で fail-closed**: 空、または
  32文字未満 ⇒ `serve` はログを出して `exit(1)` し、認証なしで
  listen することは決してない。`mrw serve up` は常に64桁16進数の
  新しい token を発行するので、想定されるフローでこの経路が使われる
  ことはない——これは `mrw` の外で `serve` イメージを手動実行する
  誰かのために存在する。
- **どこにもインラインの script も style もない**——CSP
  (`default-src 'none'; script-src 'self'; style-src 'self'; …`)に
  `'unsafe-inline'` はない。すべての JS/CSS はイメージに焼き込まれた
  `/assets/*` ファイルに存在する。
- **公開ポートは `127.0.0.1` のみ**、compose の `ports:` レベルで
  `0.0.0.0` になることは決してない(`SERVE_BIND=0.0.0.0` が安全なのは
  *この* ホスト側の制限の*おかげ*——`docker-compose.yml` の `serve`
  service 自身のコメントを参照)。
- **`approve` network は非 internal な bridge**(`caged` とは異なる)
  ——これは正直に受け入れられたトレードオフであり、見落としではない
  ——`docker-compose.yml` のそのネットワークのコメントブロックと、
  上記の[信頼モデル](#信頼モデル-侵害された-serve-にできることできないこと)
  節の完全な理由付けを参照。

## トラブルシューティング

- **ページが「broker unreachable」を表示する。** `serve` プロセスは
  `approve-sock` ボリュームに到達できるが、その先で listen している
  ものが何もない——ほぼ常に `broker` コンテナが起動していないことが
  原因。`mrw infra-up` を実行する(または
  `docker compose -f .devcontainer/docker-compose.yml ps broker` で
  確認する)と、ページは次のポーリングで回復する。`serve` の再起動は
  不要。
- **タブ / URL / token を見失った。** `mrw serve url` を実行する——
  稼働中の `serve` コンテナから実際に公開されているポートと
  session token を読み出し(`docker port` / `docker inspect`)、
  `http://localhost:<port>/?token=<token>` を再出力する。`serve` が
  起動していない場合はきれいにエラーになる(先に `mrw serve up` を)。
- **ポートが既に使用中 / 別のポートを使いたい。** 1回だけなら
  `mrw serve up --port N`、恒久的には `serve.json` の `"port"` を
  設定する。以前のインスタンスがまだ古いポートを保持している場合は
  先に `mrw serve down` を。
- **bootstrap URL で 403。** URL 内の token が稼働中コンテナの
  `SERVE_SESSION_TOKEN` と一致していない——通常は URL が古い
  (`mrw serve up` を実行するたびに新しい token が発行されるため、
  以前の実行のもの)ことが原因。`mrw serve url` で現在のものを取得する。
- **一見有効そうな token でも 403。** ブラウジングしている `Host` を
  確認すること——`localhost`、`127.0.0.1`、`[::1]` のいずれかで
  なければならない。reverse proxy、`Host` を書き換える SSH
  ポートフォワード、`/etc/hosts` エイリアスは、設計によりこの
  チェックに失敗する([セキュリティ不変条件](#セキュリティ不変条件)
  参照)——本機能は意図的にリモート/トンネル経由のアクセス向けには
  作られていない(`mrw-cli.md` の Thread B 節の "Out of scope" を参照)。
- **Approve ボタンが有効にならない。** タイプしたテキストがヘッダーに
  表示されている short sha と完全に一致(大文字小文字を区別、前後の
  空白はトリム)して初めて有効になる——これは意図的な手間であり、
  TTY ゲートが常に持っていたのと同じ性質。
- **「attempts exhausted」/ 自動 decline。** sha の誤入力3回で
  pending な publish が自動的に decline される(UI 上の制限だけでなく、
  プロトコルがサーバー側で強制する同じ予算)——publish ステップを
  再実行すれば新しい pending リクエストと新しい試行予算が得られる。
