# Handoff protocol

`tasks/<T>/docs/handoff/` は、worker と orchestrator の間の構造化された非同期
チャネル — 揮発性の cmux ペイン I/O を補う永続的な補完物。これは
**追記専用のイベントログ**であり、状態は常にファイルから導出され、書き換えられる
ことは決してない。

> 🇬🇧 English: [handoff-protocol.md](handoff-protocol.md)

## Rules

1. **1 メッセージ = 1 ファイル。** 既存ファイルは編集も削除もしない。
2. **ファイル名**: `YYYYMMDD_HHmmss_NNN_<from>.md`
   - タイムスタンプは `date +%Y%m%d_%H%M%S` から
   - `NNN`: 3 桁の連番。送信者に関係なくディレクトリ内の最大 `NNN` より 1 大きい値
     とする — 順序・鮮度・メッセージの同一性を与える
   - `<from>`: `worker` または `orchestrator`
3. `docs/` はタスクローカル: handoff ファイルは PR diff に一切現れない
   (push されるのは `repositories/` の内容だけ)。

## Worker messages (`type: report`)

worker は**各ステップの完了時、あらゆるブロッカー発生時、そして全体の完了時**に
report を追記し、その後アイドルに入る。決して exit しない — アイドルなプロンプトが
「次の指示を受け付ける準備ができた」というシグナル(`wait-for-worker` がそれを
検出する)。

```yaml
type: report
status: in_progress | awaiting_next | blocked | complete | failed
task_ref: docs/task.md step3
summary: |
  What was done, current state, what remains.
requests:                      # only when privileged action is needed
  - id: req-007-1              # <file seq>-<n>: unique forever
    action: push_and_pr | install_package | other
    repo: example-app
    branch: feat/TICKET-1
    pr_title: "fix: ..."       # for push_and_pr the worker drafts the PR text
    pr_body: |
      ...
    detail: "pnpm add zod"     # for install_package / other
```

worker は特権的な操作(push、PR、パッケージインストール、ネットワーク、
`agents/`/`scripts/` への書き込み)を**自分で試みてはならない**: sandbox がそれらを
ブロックし、リトライは context を浪費する。リクエスト → アイドルが常に正しい動き。

## Orchestrator messages (`type: result`)

リクエストを処理した後、orchestrator は結果を記録する:

```yaml
type: result
refs: req-007-1
status: done | failed | deferred
summary: |
  PR created: https://github.com/...
```

## Derived state (no status file exists)

| 問い | 答え |
|---|---|
| 現在の worker の状態 | 最大 seq の `*_worker.md` → その `status:` |
| 未処理のリクエスト | `refs:` が一致する `*_orchestrator.md` が存在しない `request` の id |
| orchestrator の読み取り位置 | 最大 seq の `*_orchestrator.md` |

## Division of labor (build / test / install)

| 作業 | 誰が |
|---|---|
| 初期セットアップ: 依存インストール、docker、初回 build | **人間**、Terminal タブ、open-task 時 |
| サイクル内の lint / build / test(既存の依存) | **Worker**、sandbox 内 |
| パッケージの追加/アップグレード | **人間**が Terminal で(worker が `install_package` でリクエストし、orchestrator が中継して待つ — orchestrator もインストールを実行してはならない) |
| push / PR | **Orchestrator** が `scripts/push-create-pr.sh` 経由で(diff をレビューした後。想定外のものはすべて人間の承認を得る) |

## Orchestrator loop (normative)

1. `send-command.sh "<instruction>"`
2. `wait-for-worker.sh` を `run_in_background: true` で → **ターンを終える**
3. `RESULT status=idle` のとき: 最新の `*_worker.md` を Read する(Read ツールで —
   `agents/` 配下で bash は決して使わない。そこでの sandbox の denyRead により bash は
   `Operation not permitted` で失敗するが、これは想定どおりであって追いかけるべき
   エラーではない)
4. 未処理のリクエストを処理し、`*_orchestrator.md` の結果を追記する
5. 次の指示。`status: complete` かつ未処理のリクエストが無くなったら停止する

`RESULT status=dead` → worker セッションが消えた: 人間に伝える / `/start-task`。
`RESULT status=timeout` → ペインを読み(`read-output.sh`)、判断し、再度アームする。
`RESULT status=error` → wait ヘルパーが実行できなかった(`reason=` がそれを示す。例:
`~/.cmux-state.sh` が無い): worker の状態ではなく環境の障害 — 人間に
`/setup-workspace` を再実行するよう伝える。
