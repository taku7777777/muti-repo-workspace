# multi-repo-workspace

**複数リポジトリにまたがる、サンドボックス化されたマルチエージェント Claude
Code セッション**を実行するための、Git リポジトリの形をしたワークスペース。
チケット1件につき1つの隔離されたワークスペースを持ち、オーケストレーター
エージェントがサンドボックス化されたワーカーエージェントに指示を出します。

> 🇬🇧 English version: [README.md](README.md)

クローンして `config/repos.json` に対象リポジトリを列挙すれば、どのチケットにも
以下が用意されます:

- チケットごとのディレクトリ `tasks/<TICKET_ID>/`。関連する各リポジトリの
  **git worktree**(ブランチ `feat/<TICKET_ID>`)を持つ — 安価・使い捨て・隔離済み;
- **ワーカー** Claude。OS レベルのサンドボックス内で自律的に編集・ビルド・
  テスト・コミットを行う(ネットワーク・push・シークレット・設定改変はすべて不可);
- **オーケストレーター** Claude。[cmux](https://github.com/wandb/cmux) 越しに
  ワーカーへ指示を出し、追記専用の**ハンドオフログ**で結果をレビューし、
  特権を要する手順(push・PR 作成)を担う;
- 人間用のプレーンな**ターミナル**タブ。インストール・docker・脱出ハッチ。

```
┌───────────────────────── cmux workspace "<TICKET_ID>" ─────────────────────────┐
│ Tab 1 Worker Claude        Tab 2 Terminal           Tab 3 Orchestrator Claude  │
│ tasks/T/agents/worker      tasks/T                  tasks/T/agents/orchestrator│
│ edit·build·test·commit     human: install, docker   send / wait / read / PR    │
└────────────────────────────────────────────────────────────────────────────────┘
            ▲  writes docs/handoff/*_worker.md          │ cmux send (pinned target)
            └────────── shared: docs/, repositories/ ◄──┘
```

## なぜ

`--dangerously-skip-permissions` でエージェントを走らせるのは速いが無制限。
コマンドごとに確認プロンプトを出すのは安全だが使い物にならない。この
ワークスペースは第3の道をとります: **ロールごとに OS が強制するサンドボックス
境界**。ワーカーは push・情報流出・認証情報の読み取り・自身の権限拡大が
*物理的に不可能*だからこそ、確認プロンプトゼロで動けます。特権(push/PR)を
必要とするロールには、汎用シェルではなく、単一目的・リテラルパスの許可リスト
スクリプト経由でのみそれを与えます。

| レイヤ | CWD | ネットワーク | 書き込み |
|---|---|---|---|
| Root(管理コンソール) | リポジトリルート | github.com, npm レジストリ | ワークスペースの足場作り |
| Origins | `repositories/` | — | なし(worktree の元、読み取り専用) |
| Worker(タスクごと) | `tasks/T/agents/worker/` | なし(localhost のみ) | タスク worktree と docs のみ |
| Orchestrator(タスクごと) | `tasks/T/agents/orchestrator/` | なし(PR は除外スクリプト経由) | docs のみ |

## 必要要件

- macOS(サンドボックスは Claude Code の macOS サンドボックスを使用。`--no-sandbox` モードは他 OS でも動作)
- `git`, `jq`, `curl`, [GitHub CLI `gh`](https://cli.github.com/)、対象リポジトリへの SSH アクセス
- [Claude Code](https://claude.com/claude-code)
- [`cmux`](https://github.com/wandb/cmux) — 任意だが強く推奨
  (無い場合はクリップボードにフォールバックする単一セッションモードになります)

## クイックスタート

```bash
git clone <this-repo> my-workspace && cd my-workspace

# 1. リポジトリとポリシーを記述する
$EDITOR config/repos.json        # このワークスペースが管理するリポジトリ
$EDITOR config/workspace.json    # push 許可 org、チケットソース、ブランチ接頭辞

# 2. Claude にすべてセットアップさせる
claude
> /setup-workspace               # リポジトリのクローン、フック/設定/ヘルパーのインストール

# 3. タスクを開く
> /open-task                     # チケット id → 目的 → リポジトリ → 3つの cmux タブ
```

あとはタブ1でワーカーがチケットに着手するのを見守り、タブ3のオーケストレーター
から操縦してください(あるいは自走させる — オーケストレーターは
指示 → 待機 → ハンドオフ読み取り → push/PR のループを回します)。

## 設定

| ファイル | 編集する内容 |
|---|---|
| `config/repos.json` | 対象リポジトリ(`name`, `url`, `type: code\|knowledge`, sparse パス) |
| `config/workspace.json` | `allowed_push_orgs`(pre-push フック)、チケットソースアダプタ、ブランチ接頭辞 |
| `config/purposes/*.json` | タスクの目的: デフォルトリポジトリ、MCP サーバ、サブ種別。JSON を1つ追加 = 目的を1つ追加 |
| `templates/` | /open-task が生成するすべて(設定、CLAUDE.md、プロンプト)— プレースホルダは実行時に置換される |
| `templates/default/mcp.json` | MCP サーバのカタログ。各目的は名前でここからサーバを選ぶ |

より充実した目的定義(インシデント対応、プロジェクト計画)や追加のチケット
ソースアダプタは `examples/` を参照してください。

## 仕組み

- **クローンではなく worktree**: `repositories/<repo>` は一度だけクローンされ、
  `tasks/<T>/repositories/<repo>` は同じオブジェクトストアを共有する
  ブランチ `feat/<T>` の `git worktree` です。`type: knowledge` のリポジトリは
  タスクの目的に設定されたパスのみを sparse チェックアウトします。
- **ワーカーターゲットのピン留め**: /open-task がワーカータブを作るとき、
  cmux ワークスペース + surface の UUID を、オーケストレーターが読めるが
  決して書き換えられないファイルに書き込みます。メッセージング用スキルは
  `--workspace`/`--surface` の上書きを拒否する — オーケストレーターは常に
  自分のワーカーにしか指示できません。
- **ハンドオフログ**: `tasks/<T>/docs/handoff/` は追記専用のイベントログ
  (`YYYYMMDD_HHmmss_NNN_<role>.md`)。ワーカーはここに状態を報告し特権
  アクションを要求し、オーケストレーターは結果ファイルで応答します。状態は
  常にファイルから導出され、何も破壊的に変更されません。
- **終了せず待機(idle-not-exit)**: ワーカーは決して終了しません。報告し、
  idle になり、次の cmux 指示を待ちます — 1つのセッションがチケット全体で
  タスクのコンテキストを蓄積します。
- **ファイルとしての特権境界**: push/PR は `scripts/push-create-pr.sh` を経由します。
  これはオーケストレーターが実行できる(サンドボックス除外・リテラルパス一致)が
  編集はできない(denyWrite)スクリプトです。pre-push フックが push 先を
  `allowed_push_orgs` に制限します。

詳細: [`docs/architecture.md`](docs/architecture.md),
[`docs/handoff-protocol.md`](docs/handoff-protocol.md),
[`docs/settings-reference/`](docs/settings-reference/),
[`docs/verification-guide.md`](docs/verification-guide.md).

## リポジトリ構成

```
.claude/skills/        管理スキル(/setup-workspace, /open-task, ...)
config/                ワークスペース定義(リポジトリ、目的、ポリシー)
templates/             /open-task が生成するすべての元
scripts/               ワークスペースの機構(セットアップ、タスク作成、cmux ヘルパー)
docs/                  アーキテクチャ / プロトコル / 設定リファレンス
examples/              任意の目的設定とチケットソースアダプタ
repositories/          クローンされた対象リポジトリ  (生成物、gitignore 対象)
tasks/                 チケットごとのワークスペース    (生成物、gitignore 対象)
```

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
