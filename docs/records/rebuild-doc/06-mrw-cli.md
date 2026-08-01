# 06 — mrw CLI と状態外部化 実装仕様

> 対象: `cli/mrw.mjs` + `scripts/lib/common.sh` の config 解決 + compose パラメータ化 +
> triage 配線。「リポジトリがワークスペースであることをやめ、`mrw` バイナリが外部状態を
> 操作する」ための Phase 1〜2(feat/mrw ブランチで実装済み)。

## 6.0 設計の核

- **賢さは per-task Claude セッションに残す。CLI は dumb authority — 手続きだけを実行する。**
- スキル markdown → 実コードへの移行は**より厳格**になる: 不変条件が「想定」から
  「assert」になる。
- 2つの独立スレッドに分解:
  - **Thread A**(実装済み): 状態をツールの外へ(state_root 外部化、`mrw` CLI、
    per-workspace `.mrw/`、triage leaf)。
  - **Thread B**(未着手): ブラウザ承認(`mrw serve`)。§6.7 は設計のみ。

## 6.1 3つのパス概念(WORKSPACE_ROOT の多義性解消)

従来の `WORKSPACE_ROOT` 1トークンが「ツール資産」と「状態」の両方を指していた。分離後:

| 概念 | 内容 | 解決方法 |
|---|---|---|
| **toolHome** | `scripts/` `templates/` `harness/` `docker/` `.devcontainer/` `.githooks/` `.claude/` — 常にツールのチェックアウト | common.sh: `scripts/` の親。mrw.mjs: `import.meta.url` から |
| **config_dir** | `workspace.json` `repos.json` `purposes/` `broker-policy.json` | 下記 §6.2 の解決規則 |
| **state_root** | `repositories/` + `tasks/` | `workspace.json.state_root`(絶対パス必須)。空 ⇒ workspace base(workspace モードでは `.mrw/` の親、legacy では toolHome) |

**完全後方互換**: `state_root` 空 + `.mrw/` 不在なら従来とバイト単位で同一挙動。
この legacy mode の compose project name は常に `mrw-phase0`。workspace mode では
`config_base()` の正規化済み絶対パスの SHA-256 先頭12桁から `mrw-<hash12>` を導出し、
コンテナと named volume をワークスペース単位で分離する([05](05-container-path.md) §5.0)。

## 6.2 config 解決規則(3実装で一致必須)

`scripts/lib/common.sh` の `config_dir()` / `.githooks/pre-push` / `cli/mrw.mjs` の
3実装が同じ結果を返さなければならない。優先順位:

1. `$MRW_CONFIG_DIR`(設定されていれば)
2. cwd から `/` まで上位へ辿り、最初に見つかる `workspace.json` を含む `.mrw/`。
   ただし **`*/tasks` または `*/tasks/*` にマッチするディレクトリはスキップして上へ**。
3. `<toolHome>/config`(legacy フォールバック)

**tasks-セグメント拒否の理由(セキュリティ必須)**: pre-push フックは
`git -C <worktree> push` の cwd(= worker 書込可能な `state_root/tasks/**`)で走る。
worker は自分の worktree に `.mrw/workspace.json` を**コミットできる**(porcelain チェックは
通る)ので、スキップしないと `allowed_push_orgs` を偽装できる。正規のワークスペース
`.mrw/` は `tasks/` の兄弟(上位)にある。`mrw init` も tasks/ 配下での実行を拒否する。
この exploit は実際に独立レビューで発見され、コミット前に修正・ブロック検証済み。

**既知の構造的問題(再構築時は設計から回避すべき)**: walk-up 方式は「`.mrw/` は tasks/
の直上にある」前提に立つが、`state_root` を別サブツリーに外部化するとこの前提が壊れ、
pre-push が正規 config に到達できず誤ったポリシーにフォールバックする。また pre-push
だけが `MRW_CONFIG_DIR` を見ない、値の正規化(realpath・末尾スラッシュ)・検証が無い、
という不一致がある。是正方向: 単一の canonicalize+validate パスを通し、pre-push は
walk-up ではなく**セットアップ時に config パスを焼き込む**方式へ。
詳細 → [09-known-issues.md](09-known-issues.md) A 系統。

## 6.3 Phase 1 — state_root 外部化

- `common.sh` に `state_root()`(config の `.state_root`。絶対パス検証、既定 =
  workspace base)。ホストスクリプトの `repositories/`+`tasks/` 参照**のみ**を
  `STATE_ROOT` に付け替える(config/templates などは toolHome のまま)。
- compose のバインドを `${MRW_STATE_ROOT:-..}` でパラメータ化。orchestrator/broker の
  ワークスペース `:ro` マウントに、外部 state の `tasks`/`repositories` をネスト `:ro`
  オーバレイ。reviewer は無変更(ワークスペース無マウント)。
- `broker-policy.json` をビルド時 COPY → **ランタイム `:ro` バインド**に de-bake
  (`${MRW_CONFIG_DIR:-../config}/broker-policy.json`。コンテナ経路の authoritative)。
- **相対 worktree 不変条件を維持**: origin と tasks を state_root 配下の兄弟に置くので、
  `../../tasks/<T>/repositories/<r>` という相対ターゲットが state_root 内で解決し続ける。
- pre-push の `includeIf` を toolHome と state_root の**両スコープ**に登録(コンソール
  リポジトリ自体の push ガードを維持)。
- ライブ検証済み: `state_root=~/mrw-state-test` で worktree が外部に作成され
  (tool_home への漏れなし)、スタックが healthy に起動(broker の runtime-bind de-bake
  が機能)、worker が外部 tasks rw + repositories ro をマウント。その後 `state_root=""`
  に戻して byte-clean。

## 6.4 Phase 2.1 — `mrw` CLI ディスパッチャ

- `cli/mrw.mjs` = **依存ゼロの単一 plain JS ESM**(`#!/usr/bin/env node`)。
- toolHome を `import.meta.url` から解決 → どの cwd からでも実行可。
- 各サブコマンドは `spawnSync(scriptPath, args, {stdio:"inherit", cwd:toolHome})` で
  Phase-1 スクリプトへディスパッチ(**`shell:true` なし** = インジェクション耐性)。
- サブコマンド: `config` / `init` / `setup` / `infra-up` / `infra-down` / `task-up` /
  `list` / `close` / `doctor`。
- `mrw config --state-root <path>` は workspace.json を byte-clean にラウンドトリップ
  (対象キー以外を変えない)。
- Anthropic クレデンシャルのフォールバック(Keychain 読取)も devcontainer-up.sh と
  同じロジックをホスト側 triage 用に持つ。
- 既知の小欠陥(arg パース、テスト皆無)→ [09-known-issues.md](09-known-issues.md) Low。

## 6.5 Phase 2.2 — per-workspace config `.mrw/`

- ワークスペース = `.mrw/` を持つディレクトリ(配下に repositories/ + tasks/)。
  `mrw init [dir]` が雛形(workspace.json, repos.json, purposes/, broker-policy.json)を
  生成。state_root 既定 = `.mrw/` の親。
- 複数ワークスペースが自分のスタックを並走できる(ユーザーのマルチターミナル運用が要件)。
  全 compose 呼び出しが同じ決定的な `COMPOSE_PROJECT_NAME` を使うため、コンテナと named
  volume はワークスペース単位の名前空間になる。`mrw doctor` は解決済み名と稼働状態を表示する。
- broker-policy は `${MRW_CONFIG_DIR:-../config}/broker-policy.json` バインド
  (per-workspace、broker 内で authoritative)。
- pre-push フックは env 非依存で**自前 walk-up**発見(→ ただし §6.2 の既知問題あり)。
- セキュリティ修正込み: 3実装すべてが tasks/ セグメント配下の `.mrw/` を拒否。

## 6.6 Phase 2.3 / 2.4 — native パリティと triage 配線

### Phase 2.3(native macOS 経路の外部 state_root 対応)
- `add-repository.sh`: `{{WORKSPACE_ROOT}}`(toolHome)を**焼き込み**、存在すれば使用・
  無ければ `TASK_DIR/../..` フォールバック(統合コンテナ対応)。origin は `state_root()`。
- `create-workspace.sh` は orchestrator スキルスクリプトを cp ではなく **render** で
  焼き込みコピー。
- root コンソールに `additionalDirectories: ["{{STATE_ROOT}}"]`(外部 state への書込境界。
  guardrail 後退の side-effect は [09](09-known-issues.md) Low 参照)。
- `update-task-sandbox.sh --add-write <abs>` は、正規化した指定パスが解決済み `config_dir`
  自体またはその配下なら拒否する。push allowlist の実体を通常の書込拡張で再開通させてはならない。

### Phase 2.4(task-up triage leaf)
- `harness/src/triage.ts` `runTriage(text, repos) → {work_type, title, repos, summary}`。
- `work_type` は検証済み enum(`z.enum`)。`repos` はコードで availableRepos との積集合に
  絞る(subset 制約は zod で書けない)。
- `mrw task-up --from <link>`(ticket-source で取得)/ `--body-file` / `--no-triage`。
  ticket-source は [04](04-native-path.md) §4.6 の `fetch_ticket` 契約を使用する。
  triage → title/repos 自動補完。**graceful degradation**: triage 失敗(auth/gh/API)でも
  タスク作成は止めない。
- 起動: `npm run triage`(stdin / `--text-file` → JSON)。
- **trust boundary の正直さ**(設計メモの規範): ticket テキスト(github-issues では外部
  供給)から `work_type` を導出してよいのは、(a) work_type がテレメトリラベル
  (fail-open、偽データは許容済みリスク)であり、(b) 出力が検証済み語彙(enum)に制約され
  属性構文を注入できず、(c) ホスト側・ケージ外・operator 実行の task-up で設定される
  (ケージ内 coder は選べない)から。**push 先やポリシーなど権威的なものへ拡張しては
  ならない。**
- **posture の既知課題**: 現実装は `runPlan` の READ_ONLY_TOOLS 姿勢のコピーだが、
  ホスト側では不十分 → reviewer 型(`tools: []` + Read/Grep/Glob deny + 不活性 cwd)に
  すべき + 出力の C0/C1 制御文字除去。→ [09](09-known-issues.md) B 系統。

## 6.7 Thread B — ブラウザ承認(設計のみ・未実装)

- diff 概要 / レビュー結果 / 全 diff をブラウザで綺麗に表示する。ただし:
- **承認行為は SHA 打鍵を維持**(唯一の権威ゲート。SHA を打つことが「その commit を
  見た」証明。ワンクリックボタンは1ビットの同意に退化するので不可)。
- 承認サーバは攻撃面として扱う: localhost バインド + per-session トークン / CSRF 必須。
- リスナーは broker 同居ではなく**別プロセス `mrw serve`**(決定済み)。broker はホスト
  ポートを開けない(unix socket + TTY readline のみ)。`mrw serve` は**トークンを持たず**
  push できない。broker は `mrw serve` を信用せず、打鍵された短縮 SHA を pending publish
  に対して独立に再検証してから push する。

```
browser ──HTTP(localhost+token)──▶ [ mrw serve ](トークンなし、push 不可)
                                        │ unix socket
                                        ▼
                                   [ broker ](トークン、SHA 再検証、push)──▶ GitHub
```

## 6.8 合意済み設計判断(変更する場合は要再議論)

- `purposes/` は toolHome 既定のまま(per-workspace 上書きは当面なし。繰延)。
- named volume(spine-notes / review-diffs)は運用**履歴**なので既定保持。
  `mrw close --purge` で明示破棄。安全経路で履歴を自動削除しない。
- ビルド形態は**独立バイナリ/CLI `mrw`**(skills-in-session ではない)。
- worktree 作成規則(相対ターゲット・連結禁止)は、Claude が実行していたから CLAUDE.md
  ルールだった。`mrw` がコードで実行する場合は1関数の実装詳細になる(不変条件自体は維持)。

## 6.9 `mrw doctor` の検査契約

doctor は解決済み compose project name と稼働状態を最初に表示し、次を全件検査する。
各検査は PASS/FAIL と根拠を出力し、1件でも FAIL なら最後に非ゼロで終了する(途中終了せず
全項目を報告する)。

| 項目名 | 合格条件 | fail 時の挙動 |
|---|---|---|
| マウント監査 | worker の tasks は rw、origins/harness/scripts は ro、broker socket 無し。orchestrator は workspace/tasks/origins が ro、両 socket と notes rw を持つ | 差分の mount/source/mode を表示し FAIL |
| egress セルフチェック | §5.4 の6項目が全 PASS | 失敗項目を表示し FAIL |
| denyWrite 分岐 | sandbox/no-sandbox、worker/orchestrator の各生成設定が §4.3 と一致し、worker の `excludedCommands` が空 | 設定パスと不一致キーを表示し FAIL |
| config-discovery | common.sh / pre-push / mrw.mjs が同じ正規 `config_dir`/`state_root` を解決し、tasks 配下の偽 `.mrw/` を拒否 | 3実装の解決値を併記し FAIL |
| includeIf 登録 | toolHome と外部 state_root の両 scope が正しい `.gitconfig-workspace` を指す | 欠落 scope を表示し FAIL |
| フック実行可能性 | 解決した `core.hooksPath/pre-push` が存在する正規ファイルで実行可能 | パスと mode を表示し FAIL |
| telemetry 網 | `mrw-telemetry` が存在し `Internal=true` | inspect 結果を表示し FAIL |
| broker policy | 解決した `broker-policy.json` が存在し、symlink 等でない正規ファイルで、妥当な JSON かつ必須 schema を満たす | パスまたは schema error を表示し FAIL |

## 6.10 残タスク(feat/mrw 時点)

- Thread B(`mrw serve`)未着手。
- per-ticket の `work_type` → telemetry 配線(スタック共有のため `MRW_WORK_TYPE` は
  stack 単位。per-ticket 帰属は telemetry の per-ticket 分離議論と接続して要設計)。
- feat/mrw 時点の `mrw doctor` 実装は §6.9 の契約に未達(現状 verify-workspace.sh 相当)。
- master へのマージ前に [09](09-known-issues.md) のブロッカー3系統の是正が必要。
