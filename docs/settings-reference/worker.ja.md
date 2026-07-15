# 設定リファレンス — Worker(タスク単位)

生成ファイル: `tasks/<T>/agents/worker/.claude/settings.json`
テンプレート(信頼できる情報源): `templates/task-worker/claude-settings.json`
生成元: `/open-task`(create-workspace.sh の finalize)。プレースホルダを置換し、
repo ごとのエントリを注入する。

> 🇬🇧 English: [worker.md](worker.md)

## 設計目標

境界の内側では確認プロンプトをゼロにする。OS **そのもの**が境界である。
edit/build/test/commit は摩擦なく行える。一方で push・ネットワーク・秘密・
自己改変は物理的に不可能。

## 期待される挙動

| 項目 | 値 | 理由 |
|---|---|---|
| `env.OTEL_RESOURCE_ATTRIBUTES` | `workspace=<T>,purpose=<p>` | チケット単位のコスト計上 |
| `permissions.defaultMode` | `acceptEdits`(起動も `--permission-mode acceptEdits` で行う) | 編集プロンプト無し |
| `permissions.allow` | `[]` — **`Bash(*)` は無し** | `autoAllowBashIfSandboxed` がすでに sandbox 化された bash をすべて自動実行する(S4-b/c で検証済み)。広範な `Bash(*)` は増幅要因であり、将来のあらゆる脱出経路(除外コマンド、`allowUnsandboxedCommands`)を静かな完全脱出に変えてしまう(S5/e,h)。ask に落ちる唯一の形は glob→variable→file access であり、worker の CLAUDE.md が言い換えるよう指示する |
| `permissions.ask` | `[]` | worker は人間に決してプロンプトしない — ブロッカーは誰も見ていないダイアログではなく handoff ログ(`status: blocked`)へ送る |
| `sandbox.autoAllowBashIfSandboxed` | `true` | コマンドは sandbox 化されている**からこそ**自動実行される |
| `sandbox.excludedCommands` | `[]` — **空のままにする** | 自動許可層に除外コマンドが1つでもあると、`<excluded>; <anything>` で行全体が sandbox 外実行されてしまう(v2 の「F9」の発見) |
| `sandbox.allowUnsandboxedCommands` | `false` | 脱出ハッチ無し |
| 書き込みスコープ(`filesystem.allowWrite`) | `<T>/repositories`、`<T>/docs` — **origin の `.git` は注入しない** | worktree の編集 + handoff。worktree の commit は git 自身の worktree ハンドリングを通じて origin の共有 `.git` に届くので allowWrite は不要(S8-d で検証済み。Claude Code ≥ 2.1.149 が必要) |
| `filesystem.denyWrite` | `<T>/agents`、`<T>/scripts`、workspace の `.githooks`/`.claude`/`config`/`scripts`/`templates`、加えてタスクの repo ごとに注入する: origin の `.git/config`・`.git/hooks`、および worktree の `config.worktree` | 自身の settings、orchestrator、特権スクリプト、git リダイレクト面(C-2 ベクトル)を付け替えられない。denyWrite のピン留めは、「二度と確認しない」承認によって書かれた `settings.local.json` からの permission ルールのマージに対しても保持される(S2-n で検証済み: local の `Edit(...)` 許可ルールは OS の書き込み境界を広げるが、project の denyWrite がそれに勝つ) |
| Origin ソース | 読めるが書けない(allowWrite が及ばない。ツール `Edit` は workspace の `repositories/**`・`scripts/**`・`templates/**`・`config/**`・`.claude/**` で拒否) | origin 保護 |
| ネットワーク | `allowedDomains: []` — 外部は一切無し。localhost サーバはテスト用に依然動く | exfil 無し。ローカル開発ループは問題なく回る |
| WebFetch / WebSearch | 拒否 | 同上 |
| 秘密 | denyRead + credentials deny + Read ルール deny(`~/.ssh` `~/.aws` `~/.config/gh` `~/.config/gcloud` `~/.npmrc`) | 両方のアクセス経路を遮断 |
| `additionalDirectories` | **タスクディレクトリのみ** — origin は追加しない | worker はタスクディレクトリ配下の worktree で作業し、origin を直接読む必要は決してない。origin を意図的に外すのは、`additionalDirectories` のエントリが OS レベルの Bash **書き込み**境界もそのパスまで広げてしまう(S2-o)ためであり、これがあると worker が自分のタスク外で共有クローンを改変できてしまう(review Low-1 の repo ごとの read 付与を上書きする) |
| MCP | `enabledMcpjsonServers` = purpose の `mcp_servers`、`.mcp.json` は `templates/default/mcp.json` からフィルタ | MCP の面を最小化 |

## 検証用クイックチェック(worker として実行)

- 編集 + `git -C ../../repositories/<repo> commit` → 成功、プロンプト無し
- `git -C ../../repositories/<repo> push` → 失敗(ネットワーク)
- `curl https://example.com` → 失敗。`curl localhost:3000` → 許可
- `cat ~/.ssh/config` → `Operation not permitted`
- `touch ../../scripts/x` / 自身の `.claude/settings.json` の編集 → 拒否
- `git -C ../../repositories/<repo> config --worktree core.hooksPath /tmp/x` →
  `Operation not permitted`(config.worktree ピン留め — C-2 リダイレクトベクトル)
- `git -C <workspace>/repositories/<repo> config user.name x` →
  `Operation not permitted`(origin `.git/config` ピン留め)
