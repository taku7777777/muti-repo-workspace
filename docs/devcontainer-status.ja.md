# Dev Container オーケストレータ — ビルド状況とロードマップ

[../devcontainer-orchestrator-architecture.md](../../devcontainer-orchestrator-architecture.md) の設計に対応する文書。
ここでは**ビルド済み + 静的に検証済み**なものと残りを追跡する。
**live boot 状況(2026-07-14): Phase 0 と 1 は実機で稼働済み** — スタックが boot し、
egress セルフチェックは coder 内から全6項目 PASS、Phase 1 パイプラインはデモリポジトリで
1周を完走した(plan → 人間の承認 → implement → 独立レビューの承認 → test-gate green →
publish ゲート)。認証は macOS Keychain から注入したサブスクリプションの OAuth トークン。
Phase 2–3 は静的検証のみのまま。

> 🇬🇧 English: [devcontainer-status.md](devcontainer-status.md)

## ビルド済み・検証済み(Phase 0–3)

| Phase | 内容 | 検証 |
|---|---|---|
| **0** | caged な coder コンテナ(`cap_drop: ALL`、NET_ADMIN 無し、internal 専用ネットワーク) + Squid egress-allowlist サイドカー(Approach A) + egress セルフチェック | compose/JSON/shell 構文。セルフチェックが blocked-vs-allowed + docker.sock 無し + push credential 無しをアサート |
| **1** | 専用の SDK harness(`harness/`、takt は不使用): plan→[approve-plan]→implement→review⇄fix(有界)→test-gate→[approve-publish]。読み取り専用の plan/review を `tools`+`disallowedTools` で実現、test-gate は終了コードのみで分岐、不完全 diff = fail-closed | `@anthropic-ai/claude-agent-sdk` 0.3.205 に対して `tsc` green。3件のブロッキングなセキュリティ修正を適用 |
| **2** | unix ソケット越しのコンテナ外 publish broker(`broker/`): 直前に fetch した ref から ground truth を再描画し、人間が broker 側で sha をタイプして承認、承認された sha を broker が構築した allowlist 検証済み URL へ push する。coder はトークンも egress も持たない | `tsc` green。トラストモデルの再設計で4件のブロッキングなセキュリティ指摘 + 3件の再検証ブロッカーを解消 |
| **3** | マルチリポジトリドライバ(`harness/src/multi/`): リポジトリごとに呼び出せる `runOrchestrator`、`clone --reference --dissociate` による隔離 worktree(知識リポジトリは cone sparse)、リポジトリ横断の統合ゲート、再開可能なチケット状態。origin は読み取り専用マウント | `tsc` green。セキュリティ観点「ship」。sparse の空ツリーのブロッカーを修正 |

主要なセキュリティ特性(構成による。設計レビューで検証済み。ネットワーク境界と
credential 不在のアサーションは Phase 0 セルフチェックで live 検証も済み):
- C-3 のエスケープは消えた: 境界が Linux のネットワーク名前空間なので、in-shell の
  `$(...)` にはエスケープ先が無い。
- coder は push トークンも GitHub egress も決して持たない。publish はトラスト側での、
  タイプ入力による人間ゲート付きの、ground truth を再描画する操作である。
- 読み取り専用のジャッジステップは本当に読み取り専用。test gate の pass/fail は観測された
  終了コードであって、モデルの主張では決してない。

## live boot ロードマップ(Phase 4/5 の前に必須)

1. ~~Phase 0: スタックを boot + egress セルフチェック~~ **完了 2026-07-14** —
   `scripts/devcontainer-up.sh`(Keychain 注入の認証)、セルフチェック 6/6 PASS。
2. ~~Phase 1: 単一リポジトリで harness をエンドツーエンドで走らせる~~ **完了 2026-07-14** —
   デモリポジトリで1周完走。publish ゲートは設計通り拒否(broker はループ外)。
3. Phase 2: `export BROKER_GITHUB_TOKEN=…`、`config/broker-policy.json` を編集し、
   broker 経由で publish を1回通す([devcontainer-phase2.md](devcontainer-phase2.md) 参照)。
4. Phase 3: マルチリポジトリのチケットを1つ走らせる([devcontainer-phase3.md](devcontainer-phase3.md) 参照)。

実際に見つかり修正した初回 boot の摩擦(まさに静的チェックでは表面化しない類):
- bind mount された `harness/node_modules` が macOS(darwin-arm64)の esbuild バイナリを
  Linux コンテナに持ち込んだ — VS Code devcontainer フローではなく `docker compose exec`
  でアタッチした場合は `.devcontainer/postCreate.sh`(コンテナ内 `npm ci`)の実行で解消。
- Zod v4 の `z.toJSONSchema()` が draft 2020-12 のメタスキーマ参照を刻むが、同梱の
  Claude Code CLI の ajv(draft-07)はそれを解決できない — `harness/src/sdk.ts` で
  `target: "draft-7"` を指定して解消。

## Phase 4 — egress の堅牢化(設計済み・未ビルド)

Phase 0 の Squid allowlist は C-3 の壊滅的な部分を解消するが、「物理的に exfiltrate
できない」には達しない: 素のドメイン allowlist には TLS インスペクションが無いため、
許可されたホストを通じた domain-fronting と DNS-tunneling が残り、また SDK が動くには
Anthropic API トークンが境界内に存在する必要がある。Phase 4 はこれらを閉じる:

- **TLS を終端する egress proxy**(mitmproxy / Squid SSL-bump / Envoy)を、コンテナが
  信頼する CA と共に。allowlist を平文の CONNECT/SNI ではなく実ホスト + パスに対して行う。
- egress サイドカー内の **allowlist 限定 DNS リゾルバ**(coder は外部リゾルバを一切
  持たない)。DNS トンネルによる exfil を閉じる。
- **LLM egress proxy**: Anthropic 認証を proxy 経由(`ANTHROPIC_BASE_URL`)にルートし、
  使える credential が coder 境界内に置かれないようにする。
- `git+https`/`go get`/submodule 依存のための **読み取り専用 GitHub fetch proxy**。
  (broker のみの)push 経路とは分離したまま保つ。

これは Phase 0–3 が live で証明された後にビルドする。各項目は、動作する素の allowlist
ベースラインに対して検証するのが最も容易だからである。

## Phase 5 — macOS/cmux 層の廃止(live 検証まで DEFERRED)

**コンテナ経路が実機で動作すると確認されるまで実行しないこと。** 置き換えが証明される
前に、動作している macOS/seatbelt/cmux システムを削除すると、現在唯一稼働している経路を
失う。準備が整ったら、次を削除する:
`scripts/lib/effects/cmux.sh`、4つの cmux スキルスクリプト、`.worker-target` の
ピン留め、`~/.cmux-wait` の画面スクレイピング、open-task の Step 6.5 のトラストセットアップ、
`TASK_DIR_H`/`to_home_path` のバイトマッチング、空の `.git` ファイルのトリック、そして
`sandbox{}` ブロック — そして `update-task-sandbox.sh` を seatbelt-JSON 編集から
コンソール側の firewall/mount 編集へと変換する。`pre-push`(broker に移動)と追記専用の
ハンドオフプロトコル(監査証跡として)は残す。
