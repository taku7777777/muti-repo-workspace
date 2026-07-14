# 設定リファレンス — Root レイヤー

生成ファイル: `.claude/settings.json`(gitignore 対象)
テンプレート(source of truth): `templates/root/claude-settings.json`
再生成: `/setup-workspace`

> 🇬🇧 English: [root.md](root.md)

## 期待される設定

| 項目 | 値 | 理由 |
|---|---|---|
| `env.OTEL_RESOURCE_ATTRIBUTES` | `workspace=ROOT` | コスト按分 |
| Sandbox | enabled、`allowUnsandboxedCommands: false`、`excludedCommands: []` | root には unsandboxed な抜け道が無い |
| Network | `github.com`、`api.github.com`、`codeload.github.com`、`registry.npmjs.org` を allow、`uploads.github.com` を deny | clone・gh api・npm 用。uploads は exfiltration への予防としてブロック |
| Bash ノープロンプト | 読み取り専用ホワイトリスト: `ls cat find grep rg echo printf mkdir jq gh` + 読み取り専用 git(`status log diff branch worktree list`) | 検査は無償。変更操作はプロンプトを出す |
| Bash プロンプト(`ask`) | `git push *`、`rm *`(そもそも許可されていないものはすべてプロンプトになる) | 破壊的操作は常に可視化 |
| Tool deny | `Edit(/repositories/**)`(origin 保護)、`Edit(/.claude/**)`(自己保護)、`Edit(~/.claude.json)` | 設定とソースはツールから編集できない |
| 秘密情報の read | 二重に deny: sandbox の `filesystem.denyRead` + `credentials.files` deny + `~/.ssh`・`~/.aws`・`~/.config/gh`・`~/.config/gcloud`・`~/.npmrc` への `permissions.deny Read(...)` | bash 経路とツール経路の両方をブロック |
| `~/.claude.json` | ツールの Edit は deny、ただし **bash からの書き込みはプロンプト付きで許可** | open-task の trust ステップ(Step 6.5)が明示的な人間の承認のもと jq で書き込む |

## Trust

プロジェクトの `.claude/settings.json` にある `permissions.allow` は、そのディレクトリが
trust されるまで無視される(Claude Code は "Ignoring N permissions.allow entries" と表示
する)。`/setup-workspace` の後、ワークスペース root で `claude` を再起動し、trust ダイア
ログを承認すること。

## 検証クイックチェック

- `cat ~/.ssh/id_ed25519` → 失敗するはず(`Operation not permitted`)
- `curl https://example.com` → 失敗するはず(ドメインが許可されていない)
- `repositories/<repo>/README.md` への Edit ツール → deny されるはず
- `ls`、`jq . config/repos.json`、`gh pr list` → プロンプト無し
