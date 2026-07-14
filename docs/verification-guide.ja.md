# 検証ガイド

インストールがエンドツーエンドで動作することを証明する方法。fork / カスタマイズ後、
Claude Code のアップグレード後、`templates/` や `scripts/` を触った後に実行する。

> 🇬🇧 English: [verification-guide.md](verification-guide.md)

## 0. ユニットテスト(数秒)

```bash
bash tests/run-tests.sh
```

すべてのヘルパー関数(path homing、テンプレートレンダリング、override の優先順位、
ticket の検証、pre-push の org 抽出)が pass しなければならない。

## 1. Setup

```bash
bash scripts/setup-workspace.sh
```

確認事項:
- `config/repos.json` の実 repo すべてが `repositories/` 下に clone されている
- `.claude/settings.json` と `repositories/.claude/settings.json` が存在する
- `git config --global --get includeIf.gitdir:<root>/.path` が
  `<root>/.gitconfig-workspace` を指している
- `~/.cmux-wait.sh` と `~/.cmux-state.sh` が存在し実行可能である
- root で `claude` を再起動し、trust を受け入れ、"Ignoring N permissions.allow
  entries" 警告が**出ない**ことを確認する

Root sandbox のスポットチェック: [settings-reference/root.md](settings-reference/root.md) を参照。

## 2. タスク作成(cmux 不要)

```bash
bash scripts/create-workspace.sh --ticket TEST-001 --purpose dev \
  --repos "<a-real-repo>" --title "verify" --phase init --yes
bash scripts/create-workspace.sh --ticket TEST-001 --phase finalize --yes
```

`tasks/TEST-001/` 下で確認:
- worktree が存在し、branch は `feat/TEST-001`(`git -C tasks/TEST-001/repositories/<repo> branch --show-current`)
- knowledge repo はその `sparse_paths.<purpose>` ディレクトリだけを含む
- `agents/{worker,orchestrator}/` がそれぞれ `CLAUDE.md`、`initial-prompt.md`、
  `.claude/settings.json`(有効な JSON: `jq . <file>`)、空の `.git` ファイルを持つ
- worker settings の `sandbox.filesystem.allowWrite` がどの origin の `.git` も
  **含まない**(commit には不要 — S8-d)、かつ `denyWrite` が全タスク repo について
  次を pin している: `repositories/<repo>/.git/config`、`.../.git/hooks`、
  worktree の private gitdir の `config.worktree`
  (`git -C tasks/TEST-001/repositories/<repo> rev-parse --absolute-git-dir`
  で期待される prefix が分かる)
- `.task-meta.json` がタスク root に存在し、正しい
  `purpose`/`repos`/`branch` を持つ(恒久メタデータ — `/list-task` と
  add-repository がここから読む)
- worker settings の `permissions.additionalDirectories` がタスクディレクトリ
  **だけ**を列挙する — `repositories/` エントリは一切無い(origin は意図的に追加
  しない。さもなくば S2-o が OS 書き込み境界を共有 clone まで広げてしまう)
- **バイト一致**: orchestrator の `sandbox.excludedCommands` の各エントリ
  (末尾の ` *` を除く)が `agents/orchestrator/CLAUDE.md` にそのまま現れ、
  その `~` 展開したパスのファイルが存在する

## 3. cmux + agents(live)

前提: 両方の agent ディレクトリを trust する(open-task Step 6.5)、その後:

```bash
bash scripts/create-workspace.sh --ticket TEST-001 --phase cmux --yes
```

確認事項:
- cmux workspace `TEST-001` が次のタブを持つ: Worker Claude / Terminal / Orchestrator Claude
- `.worker-target` が workspace UUID + tab-1 surface UUID を含む
- tab 1: worker が `docs/task.md` を読んで起動し、**permission 警告が出ない**
- worker は最初のハンドオフレポート後に idle になる(ファイルが
  `tasks/TEST-001/docs/handoff/` に現れる)、かつ exit **しない**

orchestrator(tab 3)から、ループを1回実行:
- 指示を送る(例: "add a comment to X and commit")
- background で `wait-for-worker` → `RESULT status=idle`
- 最新のハンドオフファイルが Read ツールで読める
- worker が commit した: `git -C tasks/TEST-001/repositories/<repo> log --oneline -1`

役割ごとの sandbox スポットチェック:
[settings-reference/worker.md](settings-reference/worker.md) /
[settings-reference/orchestrator.md](settings-reference/orchestrator.md) を参照。

## 4. Publish 経路

- orchestrator: `~/.../push-create-pr.sh <repo> --title t --body b`
  - `allowed_push_orgs` に repo の org が**含まれない**場合 → pre-push がブロック
  - org を追加した場合 → push 成功、PR 作成(scratch repo を使うこと!)
- worker: `git push` → 失敗(network)

## 5. リグレッションの罠(典型的な失敗モード)

| 罠 | 期待される挙動 |
|---|---|
| excluded スクリプトを相対パスや `bash <path>` で呼ぶ | Exit 126 — リテラルなパス形式だけが動く |
| **worker の** `excludedCommands` にエントリを追加する | 絶対にやらない — `<excluded>; anything` は行全体を auto-allow 下で sandbox 無しで走らせる |
| cmux `send` を別個の `send-key enter` 無しで行う | テキストが未送信のまま残る — 常に2イベント |
| trust されていない agent ディレクトリ | "Ignoring N permissions.allow entries" → sandbox 不完全。trust を直して再起動 |
| cmux タブコマンドに `cd <abs path> &&` が無い | セッションが `$HOME` で起動しタスク settings を取り逃す |
| sandbox 化スクリプトに埋もれた `git worktree` | ブロックされる。直接 `git -C`(skill 経路)か excluded スクリプトを使う |
| surface を UUID でなく index/ref で指定する | 並び替えで壊れる — `.worker-target` は UUID を保持しなければならない |

## 6. Teardown

```bash
bash scripts/remove-workspace.sh TEST-001          # unpushed work があればブロック
bash scripts/remove-workspace.sh TEST-001 --force  # 失われるものを確認した後
```

確認: worktree が消えた(`git -C repositories/<repo> worktree list`)、cmux
workspace が閉じた、`tasks/TEST-001` が削除された。
