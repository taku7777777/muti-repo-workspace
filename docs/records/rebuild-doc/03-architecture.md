# 03 — アーキテクチャ
日付: 2026-07-17(2026-08-02 の §12.1 移行で遡及付与。値はファイルの最終更新時刻 —— 初版コミットは保存と同日のため)

## 3.1 設計原則(規範)

1. **ロール単位のサンドボックス。** 1ロール = 1つの明確な封じ込め境界。境界が同じなら
   ロールを分けない。境界は「ソース書込(none / docs-only / code)× 外部 egress
   (none / read-allowlist / write-allowlist)」の2軸で決まる。
2. **境界は OS / ネットワークトポロジで fail-closed。** Claude Code のアプリ内権限層は
   実測で fail-open(パススコープ deny が効かない、Read/Write/WebFetch/MCP/hooks が
   サンドボックスを迂回、`settings.local.json` ドリフトが deny を再開通)であることが
   確認されており、境界として使ってはならない。
3. **LLM は提案し、コード化された spine が処分する。** ケージ内のフロー判断(再計画か
   続行か、人間に何を見せるか)は LLM に委ね、セキュリティ関連の遷移(テスト真偽、
   publish 前レビュー、ループ上限、人間ゲート)はコードが持つ。
4. **publish は独立した信頼側コンポーネント(broker)の仕事。** どのロールの能力でもない。
5. **チェックの所有者は3種に分かれる。** diff レビュー = 独立 LLM(助言のみ)/
   テストゲート = 機械(exit code のみ)/ 人間ゲート = 最小限だが決定的。

## 3.2 ネイティブ経路の全体像

```
┌───────────────────────── cmux workspace "<TICKET>" ─────────────────────────┐
│ Tab 1 Worker Claude        Tab 2 Terminal           Tab 3 Orchestrator      │
│ tasks/T/agents/worker      tasks/T                  tasks/T/agents/orch...  │
│ edit·build·test·commit     human: install, docker   send / wait / read / PR │
└──────────────────────────────────────────────────────────────────────────────┘
            ▲  writes docs/handoff/*_worker.md          │ cmux send(ピン留め対象のみ)
            └────────── shared: docs/, repositories/ ◄──┘
```

4レイヤ(Root / Origins / Worker / Orchestrator)各々が独自 `.claude/settings.json` を
持つ Claude Code セッション。特権マトリクス:

| 行為 | Worker | Orchestrator | Root | 人間(Tab 2) |
|---|---|---|---|---|
| タスク worktree のコード編集 | ✅ | ❌ | ❌ | (可能だが非推奨) |
| ローカル build / lint / test | ✅ | ❌ | ❌ | ✅ |
| git commit(タスクリポジトリ) | ✅ | ❌ | ❌ | ✅ |
| git push / PR | ❌ | ✅ push-create-pr.sh 経由 | ✅ 同左 | ✅ |
| パッケージ導入 / docker | ❌ | ❌ | ask(確認付き) | ✅ |
| サンドボックス拡張 | ❌ | ❌ | ✅ /update-task-sandbox | — |
| 外部ネットワーク | ❌ | ❌ | github/npm のみ | ✅ |
| `~/.ssh` `~/.aws` 等の読取 | ❌ | ❌ | ❌ | ✅ |

実装詳細 → [04-native-path.md](04-native-path.md)。

**既知の制約 C-3**: orchestrator の特権5スクリプトは `excludedCommands` で行全体が
サンドボックス外に出る。演算子連結(`;` `&&` `|`)は権限層が捕まえるが、コマンド置換
`$(...)` の内部は見えないため、注入された orchestrator はホスト任意コマンドを実行できる。
orchestrator は「半信頼」であり、完全封じ込めは未実装(コンテナ経路は netns により
この穴自体が存在しない)。→ [09-known-issues.md](09-known-issues.md)

## 3.3 コンテナ経路の全体像

macOS サンドボックスを Linux ネットワーク名前空間境界に置換した5サービス構成:

| コンテナ | 境界(OS レイヤ) | 実行するもの |
|---|---|---|
| **worker** | worktrees **rw**、egress は Anthropic + npm registry の固定 allowlist のみ、**broker socket なし** | workerd RPC デーモン(IMPLEMENT/FIX セッション、テスト実行、決定的コミット) |
| **orchestrator** | ワークスペース全体 **:ro**、notes 用小 volume rw、broker + worker socket 保持 | コード化 spine + orchestrator LLM + 読取専用 PLAN/REVIEW |
| **broker** | LLM フリー、唯一のトークン保持者、ソース・依存はイメージ焼き込み | typed intent 検証、ground truth 描画、SHA 打鍵ゲート、push + PR |
| **reviewer** | 書込なし、ワークスペース無マウント、broker からの入力のみ | publish リクエストごとに1レビューセッション(助言のみ) |
| **egress-proxy** | caged/egress の二重ホーム、Squid allowlist | 唯一の外向き経路 |

ネットワーク: `caged`(internal: true — 外部経路ゼロ)、`egress`(bridge — proxy と
broker のみ)、`mrw-telemetry`(第2の internal 網 — worker/orchestrator/reviewer のみ参加、
otel-collector に到達)。

publish フローの信頼構造:

```
orchestrator(cage 内)                 broker(信頼側)
  spine ledger ゲート通過後            typed intent {repo,branch,title,body} 受信
  request_publish ──unix socket──▶     ① coder のローカル git config を走査(fail-closed)
                                       ② 実ブランチ/HEAD/クリーン性を git から再導出
                                       ③ host/org を in-process 検証 → 正規 URL を再構築
                                       ④ scratch repo に fetch し ground-truth diff を描画
                                       ⑤ (任意)reviewer に諮問 → tri-state 表示
                                       ⑥ 人間が短縮 SHA を打鍵(唯一の権威承認)
                                       ⑦ push 直前に同期的再検証(sha/URL/config)
                                       ⑧ 承認 sha ちょうどを push + gh pr create
```

実装詳細 → [05-container-path.md](05-container-path.md)。

## 3.4 M1〜M4 マイルストーン(コンテナ経路の構築順序)

| マイルストーン | 内容 |
|---|---|
| **Phase 0** | ケージ + egress allowlist サイドカー。セルフチェック6項目 |
| **Phase 1** | コード化ハーネスの plan→implement→review⇄fix→test-gate→approve 一周(publish なし) |
| **Phase 2** | broker 経由の実 publish(F1〜F6 の6要求) |
| **Phase 3** | マルチリポジトリ driver(combined plan gate、逐次 publish、resume) |
| **M1** | coder ケージを worker + orchestrator に分割(workerd RPC、`:ro` マウント境界) |
| **M2** | spine + LLM on rails(`npm run chat`、不変条件 ledger、typed action) |
| **M3** | broker 側 advisory reviewer(独立コンテナ、tri-state) |
| **M4** | 仕上げ(テスト5スイート、resume 修正、docs BUILT 化) |
| **item 10** | per-ticket OTEL telemetry(`mrw-telemetry` 網、自己合成属性) |

すべて 2026-07-14/15 にライブ検証済み(検証記録 → [08-verification.md](08-verification.md) §8.4)。

## 3.5 mrw CLI(状態外部化)の全体像

```
mrw config / mrw init   # repositories・tasks の置き場所と対象リポジトリを指定
mrw infra-up            # コンテナ群を起動(compose を config からパラメータ化)
mrw task-up <link>      # タスク開始(ディレクトリ生成 + cmux + LLM triage)
# → 対話形式で実装(内部で Claude セッション)
# → broker に承認依頼 → SHA 打鍵承認
```

- **toolHome**(ツールのチェックアウト: scripts/templates/harness/docker/...)と
  **state_root**(repositories/ + tasks/)と **config_dir**(workspace.json ほか)の
  3概念に分離。`WORKSPACE_ROOT` という1トークンの多義性を解消するのが本質。
- config 解決: `$MRW_CONFIG_DIR` > cwd から上位へ辿る `.mrw/workspace.json`
  (`tasks/` セグメント配下は拒否)> `toolHome/config`。
- 実装詳細 → [06-mrw-cli.md](06-mrw-cli.md)。

## 3.6 将来ロールと dispatch control plane(設計のみ・未実装)

境界マトリクス(2軸: ソース書込 × 外部 egress):

|  | egress none | egress read-allowlist | egress write-allowlist |
|---|---|---|---|
| **write none** | — | **Researcher**, **Reviewer** | **Reporter** |
| **write docs-only** | **Documenter** | (必要なら別ロール) | — |
| **write code** | **Coder** | 🚫 禁止[^fixed-infra-egress] | 🚫 禁止 |

- 🚫 の2セルが要点: code 書込ロールにタスクレベルの外部到達拡大や write-allowlist を
  与えてはならない。
- Researcher(read)と Reporter(write)は同一プロダクトでも **allowlist もロールも別**。
- git push / PR はどのロールの能力でもなく broker の仕事。
- インスタンスは per-ticket 使い捨て。チケット間共有は禁止(シークレット集積 +
  fail-open ACL 依存になるため)。
- dispatch は信頼側の control plane(`.worker-targets` マップ: ロール名 → ピン留め先。
  ロールはロール名しか指定できず surface を名指しできない)。遷移 allowlist は信頼側固定。
  no-egress → egress の遷移は typed intent + 人間ゲート + 信頼側再検証。
  **Coder → Reporter 直行は禁止**(まさに exfil 経路)。

再構築のスコープ外だが、既存実装(`.worker-target` の単数ピン、harness driver)が
この設計の前例であることは、実装判断の背景として知っておくべき。

[^fixed-infra-egress]: 推論エンドポイント + パッケージレジストリへの固定インフラ
    read-allowlist は Coder にも許容される。本表の「egress」はタスクレベルの外部到達拡大を
    指し、固定インフラは対象外。
