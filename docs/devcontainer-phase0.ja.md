# Phase 0 dev container — egress allowlist の背後の caged coder

Phase 0 は、Claude Agent SDK のコーディング harness が **push・exfiltrate・任意
ホストへの到達をいずれもできない**状態で動く、**bootable な開発環境**を提供する —
しかも人間にすべてのコマンドを承認させることなく。封じ込めは permission プロンプト
ではなく**ネットワーク境界**である。

> 🇬🇧 English: [devcontainer-phase0.md](devcontainer-phase0.md)

## ここにあるもの

| ファイル | 役割 |
|---|---|
| `.devcontainer/devcontainer.json` | Compose ベースの dev container。エディタ/harness を `coder` サービスに接続する。 |
| `.devcontainer/docker-compose.yml` | 境界を形成する2つのサービス + 2つのネットワーク。 |
| `.devcontainer/coder.Dockerfile` | Node 20 + git/jq/gh + Claude Code CLI、非 root の `node` ユーザ。 |
| `.devcontainer/postCreate.sh` | ツールを proxy に配線し、harness の依存をインストールし、self-check を走らせる。 |
| `scripts/devcontainer-up.sh` | macOS Keychain から認証情報を注入してスタックを起動する — ワークツリーに平文の秘密を置かない。 |
| `docker/egress/` | egress ゲートウェイ: Squid + 焼き込み済み allowlist + entrypoint。 |
| `scripts/egress-selfcheck.sh` | 境界が閉じておりかつ使えることを coder 側から証明する。 |
| `harness/` | 専用の SDK オーケストレータのスケルトン(plan → implement → test → approve → publish-stub)。 |

## 境界(なぜ保たれるのか)

**Approach A: 明示的な Squid フォワード proxy のサイドカー**を採用する。透過的な
NET_ADMIN ゲートウェイより厳密に権限が小さく、TLS 傍受なしで真のドメイン allowlist
を与えるため、こちらを選んだ。

```
        caged  (internal: true — インターネットへの経路なし)
   ┌───────────────────────────────────────────────┐
   │   coder  ───HTTP(S)_PROXY──►  egress-proxy     │
   │  (cap_drop ALL,               (Squid, allowlist,│
   │   no NET_ADMIN,                cap_drop ALL)     │
   │   no docker.sock,                   │           │
   │   no host secrets)                  │           │
   └─────────────────────────────────────┼───────────┘
                                         │  egress (bridge)
                                         ▼
                                 allowlist されたホストのみ
                                 (api.anthropic.com, …)
```

3つの独立した事実がこれを fail-closed にする:

1. **トポロジ。** `coder` は `internal: true` で作られた Docker ネットワーク
   `caged` に**のみ**接続され、ホスト外へのデフォルトルートを持たない。
   `HTTP(S)_PROXY` を無視するツールはパケットの送り先が無く、壊れるだけで何も漏れ
   ない。proxy を尊重するのは*使いやすさ*の性質であって、セキュリティの性質では
   ない。
2. **Allowlist。** 外に出る唯一の経路は `egress-proxy` で、**平文 CONNECT ホストに
   対するドメイン allowlist**(`docker/egress/allowlist.txt`)を強制する。TLS 終端
   なし、coder 内に CA なし。CONNECT は :443 に制限される。
3. **自己昇格なし。** どちらのコンテナも `NET_ADMIN`/`NET_RAW` を持たない
   (`cap_drop: [ALL]`)。allowlist は proxy イメージに焼き込まれ、読み取り専用で、
   coder が exec で入ることも再設定することもできない別コンテナにある。書き換え
   られるワークロード内ファイアウォールは存在しない。

## Boot する

前提: Docker Desktop(macOS の開発ホスト。コンテナは Linux)**かつ Compose v2
プラグイン** — `docker compose version` で確認する。もし
`docker: 'compose' is not a docker command` と表示されたら、プラグインが無い
(Docker Desktop なしの素の `docker` CLI、または最小インストール): 
`docker-compose-plugin` パッケージか Docker Desktop をインストールするか、以下の
コマンドで単体の `docker-compose` バイナリに置き換える。devcontainer の
`dockerComposeFile` もこのプラグインを必要とする。

```bash
# 1. Anthropic の認証情報を macOS Keychain に保存する(一度だけ。コミットしない、
#    焼き込まない、ワークツリーにも書かない)。
#    Pro/Max サブスクリプション:  claude setup-token   # 1年有効の OAuth トークン(ブラウザ、初回のみ)
security add-generic-password -a "$USER" -s claude-code-oauth-token -w '<token>'
#    (従量課金の代替: 代わりにシェルで ANTHROPIC_API_KEY を export する)

# 2. 立ち上げて境界を証明する。スクリプトが Keychain から認証情報を取り出し、
#    シェル環境変数経由で渡す — compose に env_file は無い。
scripts/devcontainer-up.sh --build
docker compose -f .devcontainer/docker-compose.yml exec coder \
  bash scripts/egress-selfcheck.sh
```

VS Code / Cursor の "Reopen in Container" も使えるが、compose を実行するプロセスの
環境に認証情報が必要 — export したシェルからエディタを起動するか、先に
`scripts/devcontainer-up.sh` で起動してからアタッチする。

期待される self-check の結果: `example.com` は**ブロック**、`api.anthropic.com`
は**到達可能**、直接(no-proxy)の egress は**ルートなし** → `egress-selfcheck: OK`。

## harness を走らせる

coder の中(dev container のターミナル、または `docker compose … exec coder`)で:

```bash
cd harness
npm run orchestrate -- "add a --version flag to the CLI"
```

オーケストレータは **plan** と **implement** を別々の `query()` セッションとして
走らせ、repo の**テストコマンド**をゲートとして走らせ(終了コードで分岐)、
**publish スタブ**の前の明示的な**人間承認ゲート**で止まる。`REPO_DIR`、
`TEST_COMMAND`、`HARNESS_MODEL` で設定する。

## Phase 0 が保証すること・**しない**こと

**すること:**
- coder は allowlist 外のどのホストにも到達できない(トポロジ + proxy による fail-closed)。
- coder は昇格した capability も、Docker ソケットも、ホストの秘密のマウントも持たない。
- **coder は push できない** — GitHub ホストが allowlist されておらず、かつ coder は
  git-push クレデンシャルを持たない。self-check が両方を検証する(Docker ソケット
  なし、`GITHUB_TOKEN`/`GH_TOKEN`/… の env なし、`credential.helper` なし)ので、
  これは仮定ではなく*テスト済み*である。
- API キーは実行時のみ注入され、どのイメージにも焼き込まれない。
- egress は boot 時に自動 self-check で証明される。
- パイプラインは、実テストゲートと人間ゲートを備えた決定論的なコード化された制御
  フローである。

**しないこと(後のフェーズ):**
- **Publish。** Phase 0 の allowlist には GitHub ホストが一切無いので、push 経路は
  存在しない(fetch 経路も無い — repo は bind マウントなので不要)。注意:
  ドメイン allowlist は `git fetch` と `git push` を区別**できない**(同じ
  host:port)ので、後の必要から git+https の依存のために `.github.com` を足すことに
  なった場合、push の封じ込めはクレデンシャルの不在(self-check が既にテスト済み)
  にフォールバックする。実際の publish は、専用の *publish broker* に移り、それ自身の
  絞られた allowlist と、既存の pre-push の org/host バリデーション +
  `push-create-pr.sh` の堅牢化を持つ。
- **Multi-repo** のオーケストレーション。
- **TLS 終端 / L7 の堅牢化**(パス/メソッド/ボディのフィルタリングには SSL-bump +
  CA が必要になり、Phase 0 では意図的に避けている)。
- **コンテナランタイムからの認証情報の秘匿。** at rest では macOS Keychain のみに
  存在する(ワークツリーに平文なし)が、実行中のコンテナ env は `docker inspect` で
  見える — coder 自身が API を呼ぶ以上、これは避けられない。封じ込めは egress
  allowlist が担う: 出口が `api.anthropic.com` だけなので、プロンプトインジェクション
  された coder に exfiltrate 先は無い。
- **allowlist されたホストの悪用を防ぐこと**(例: 悪意ある npm パッケージ)。Phase 0
  はトラフィックが*どこへ*行けるかをゲートするのであって、信頼されたホストが*何を*
  返すかはゲートしない。

## 注記 / 保守的な選択

- **フォールバック(Approach B)。** 将来のツールが明示的 proxy を尊重できない場合、
  文書化されたフォールバックは、`NET_ADMIN` を持つ透過的ゲートウェイ(coder は依然
  として持たない)で、iptables REDIRECT + IP allowlist を行う — SSL-bump(coder 内の
  CA、ピン留めを壊す)か、DNS を `127.0.0.11` にピン留めした IP のみの allowlist の
  いずれかを受け入れる。今は作らない。
- **SSH 越しの git は `HTTP(S)_PROXY` を尊重しない。** coder では HTTPS リモートを
  使う。SSH は `ProxyCommand` を設定しない限り fail closed(ルートなし)になる。
- **IPv6** は coder ネットワークで無効のまま(Docker のデフォルト)。フィルタされない
  v6 経路は v4 allowlist を迂回してしまう。
- **SDK バージョンはピン留め**(`@anthropic-ai/claude-agent-sdk` 0.3.205)。0.3.x
  系はほぼリリースごとにオプションが変わる。バンプするたびに self-check と typecheck
  を再実行すること。
