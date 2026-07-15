# 役割別 egress セルフチェック(設計メモ)

**ステータス: 設計のみ・未実装。** [agent-roles.md](agent-roles.md) の姉妹編。
現在 `scripts/egress-selfcheck.sh` は境界を*1つ*だけ証明している — caged な coder
(allowlist 以外には何も到達不可、proxy をバイパスする経路無し、DNS 無し、docker
socket 無し、push クレデンシャル無し)。役割が別々の egress を持つようになれば
(Researcher = read、Reporter = write)、各役割には proxy が自分の allowlist を
ちょうど通しそれ以外をすべて拒否するという*自分専用の*証明が必要になる。本メモは
その一般化を設計する — そして、ドメインのみの allowlist が何を強制でき何を強制でき
ないかを正直に述べる。

> 🇬🇧 English: [egress-selfcheck-per-role.md](egress-selfcheck-per-role.md)

## 現行スクリプトがすること(一般化の起点となるベースライン)

`egress-selfcheck.sh` は coder から実行され、6つのことを表明する:

1. allowlist に無いホスト(`example.com`)は proxy によって**ブロックされる**。
2. allowlist にあるホスト(`api.anthropic.com`)は**到達可能**。
3. **トポロジの fail-closed**: proxy をバイパス(`--noproxy`)しても外への経路が無い。
4. 役割から直接の外部 **DNS** が無い(proxy が名前解決する)。
5. **Docker socket** が無い(制御 socket があると兄弟コンテナへの脱出を許す)。
6. env にも `credential.helper` にも **git-push クレデンシャル**が無い。

チェック 3〜6 は役割に依存しない不変条件(*すべての*境界で成り立つ)。チェック
1〜2 が**役割別かつデータ駆動**にならなければならない部分:「許可」集合と「ブロック」
集合は役割ごとに異なる。

## 一般化

### 役割別 allowlist マニフェスト

各役割は、到達してよいホストを列挙したマニフェストを持つ。空 = egress 無し。

```
docker/egress/roles/coder.allow        # (empty)
docker/egress/roles/documenter.allow   # (empty, or api.anthropic.com)
docker/egress/roles/reviewer.allow     # (empty)
docker/egress/roles/researcher.allow   # slack.com, api.notion.com, api.datadoghq.com, <cloud-logging>
docker/egress/roles/reporter.allow     # slack.com, api.notion.com
```

**同一の**マニフェストが2つの利用者にとって唯一の信頼できる情報源(single source
of truth)となる:

- その役割のソースネットワークに対する egress-proxy の ACL(実際に強制されるもの)、
  および
- セルフチェックの「到達可能と期待する」集合(我々が表明するもの)。

両方を1つのファイルから導出することが要点:「proxy が許可するもの」と「我々が
テストするもの」の間のドリフトは、両者が同じマニフェストを読む限りありえない。

### パラメータ化されたチェック

`egress-selfcheck.sh --role <name>`(その役割のコンテナから実行):

- **到達性(使えること):** `<role>.allow` 内のすべてのホストについて、到達可能を
  期待する(proxy 経由で curl が exit 0)。厳しすぎて壊れた allowlist はここで失敗する。
- **閉包性(拒否されること):** 固定の**カナリア集合** — `example.com` に加え、
  他のすべての役割の*排他的な*エンドポイント — についてブロックを期待する。これは
  役割間のにじみ出しテスト: Reporter からは `api.datadoghq.com`(Researcher 専用)が
  ブロックされねばならず、Researcher からは code ホスト(`github.com`)がブロック
  されねばならない。
- **allowlist が空の役割(Coder / Documenter / Reviewer):** カナリア集合の**すべて**が
  ブロックされる、すなわち役割が完全に caged であることを表明する。チェック 3〜6
  (トポロジ、DNS、docker、クレデンシャル)をそのまま再利用する。
- **egress を持つ役割(Researcher / Reporter):** チェック 3(トポロジ)が**変わる** —
  これらの役割は proxy 経由で外への経路を*持つ*ので、「proxy バイパス経路無し」は
  依然成り立つ(インターネットには proxy を*通して*のみ到達し、迂回しては到達しない)
  が、「何も到達不可」は成り立たない。チェック 4〜6 は依然成り立つ: 直接 DNS 無し
  (proxy が名前解決する)、docker socket 無し、そして — 決定的に — **git-push
  クレデンシャル無し**(push は broker だけのもの。egress を持つ役割は決してそれを
  携えてはならない)。

### 正直な限界: ドメイン allowlist は同一ホスト上で read と write を分けられない

agent-roles.md は Researcher(read)と Reporter(write)を分けている。平文の CONNECT
ホストに対する素のドメイン allowlist は、両者が*同じ*ホストを使うときその分割を
**強制できない** — まさに現行スクリプトが git について既に指摘している限界だ
(「ドメイン allowlist では git fetch と git push を区別できない。同じ host:port」)。
セルフチェックがごまかしてはならない帰結:

- Researcher-read と Reporter-write が**同じホスト**(例: 両方 `api.notion.com`)に
  当たる場合、そのホストを通すドメイン allowlist は*両方*の動詞を通す。read/write の
  分割はそのとき**強制ではなく助言**になる — プロンプト注入された Researcher が
  そのホストへ write を発行できてしまう。
- 分割を実効化する方法は2つ、どちらも live で検証すべき:
  1. **プロダクトが許す場合はホストを分ける**(例: 読み取り専用 API サブドメイン
     対 write エンドポイント) — そうすればドメイン allowlist で十分であり、上記の
     カナリアテストが実際に分割を証明する。
  2. **フェーズ4の TLS 終端 proxy**(host + **path** + method の allowlist)。ここで
     「Reporter は `chat.postMessage` を POST してよいが Researcher はしてはならない」が
     強制可能になる。それまでは、セルフチェックは read 役割と write 役割の両方の
     マニフェストに現れるホストを、黙って通すのではなく **「split-not-enforced
     (domain-only)」と明示的に報告**すべきだ。

これがチェックを正直に保つ: トポロジが強制するものを証明し、強制できないものを*旗
立てする*ことで、その層が提供しない保証をほのめかさない。

## 提案する形

```
scripts/egress-selfcheck.sh --role <name>
  load docker/egress/roles/<name>.allow
  ROLE_INVARIANTS:            # 3–6, adjusted for egress-capable roles
    - no proxy-bypass route (always)
    - no direct external DNS (always)
    - no docker socket (always)
    - no git-push credential (always, except the broker which is not a role here)
  REACHABILITY:               # every allow entry reachable via proxy
  CLOSURE:                    # example.com + other-roles' exclusive hosts blocked
  SPLIT_AUDIT:                # any host shared by a read-role and write-role manifest
                              #   -> report "split-not-enforced (domain-only)"
  exit non-zero on any REACHABILITY/CLOSURE/INVARIANT violation
```

macOS/ホスト版(コンテナ無しで実行される役割向け)は、同じマニフェストを sandbox の
`network.allowedDomains` と突き合わせてチェックする。ただしその経路はアプリ層で
fail-open であることに注意 — コンテナの役割別 proxy が fail-closed の形であり、これらの
表明が守ろうとしている対象だ。

## 未解決の論点 / 次の一手

1. **source 別 ACL を持つ proxy 1つか、役割ごとに proxy か?** Squid は source
   ネットワークで ACL を切れるので、caged ネットワークごとに `role.allow` 由来の ACL を
   持つ `egress-proxy` 1つでおそらく十分。役割ごとの proxy は推論が簡単だが重い。
   2つ目の egress 役割が着地したときに決める。
2. **マニフェストがどこに置かれ、誰が書くか。** 信頼側でイメージに焼き込む
   (`broker-policy.json` のように)。coder が書き込めるツリーには決して置かない —
   役割が自分の allowlist を編集してはならない。
3. **CI + postCreate へ組み込む。** 各役割のセルフチェックを `docker compose up` の後に
   走らせる(フェーズ0が既に `postCreate.sh` で coder チェックを走らせているように)。
   そうすれば境界のリグレッションが後の push ではなく boot を失敗させる。
4. **まず live 検証。** これらはまだ何一つ boot されていない。最初のタスクは依然として
   フェーズ0〜3の live boot([devcontainer-status.md](devcontainer-status.md))。役割別
   チェックは2つ目の境界が実際に存在して初めて意味を持つ。
