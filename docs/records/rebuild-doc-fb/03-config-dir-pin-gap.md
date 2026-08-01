# 03 — workspace モードの `.mrw/` が denyWrite ピン対象外(High: 設計改善候補・新規発見)
日付: 2026-07-16(2026-08-02 の §12.1 移行で遡及付与。値はファイルの最終更新時刻 —— 初版コミットは保存と同日のため)

rebuild-doc の仕様を突き合わせて見つかった、**09-known-issues.md に未記載**の
改善候補。仕様どおりに再構築すると同じ穴を持つ成果物ができる。

## 対象箇所

- `04-native-path.md` §4.3 Worker の denyWrite 列挙:
  `{{TASK_DIR}}/agents` `{{TASK_DIR}}/scripts` `{{WORKSPACE_ROOT}}/.githooks`
  `{{WORKSPACE_ROOT}}/.claude` `{{WORKSPACE_ROOT}}/config` `{{WORKSPACE_ROOT}}/scripts`
  `{{WORKSPACE_ROOT}}/templates` `~/.claude.json` + 動的 per-repo ピン
- `04-native-path.md` §4.2 プレースホルダ一覧(10個 — `CONFIG_DIR` 相当は存在しない)
- `06-mrw-cli.md` §6.5: workspace モードでは実効 config は `.mrw/`
  (`allowed_push_orgs` / `allowed_push_hosts` を含む `workspace.json`)
- `04-native-path.md` §4.10-4 / `07-security-invariants.md` INV-7:
  「denyWrite はあらゆる allow に勝つ(**『今後確認しない』による settings.local.json の
  ドリフトも含め**)」— ドリフトを実在の脅威と認めた上で、制御面は denyWrite で
  ピンするのがこのシステムの設計原則

## 指摘

denyWrite ピンの対象は `{{WORKSPACE_ROOT}}/config`(= **toolHome の legacy config**)
だけで、workspace モードで実際にポリシー源となる **`.mrw/`(config_dir)を指す
プレースホルダもピンも存在しない**。

- 平常時は `filesystem.allowWrite` が worktree + docs に限定されているため、
  worker は `.mrw/` に書けない(default-deny で守られている)。
- しかしこのシステム自身が「allow 側は settings.local.json ドリフトで再開通しうる。
  だから制御面は denyWrite で二重化する」と宣言している(§4.10-4)。その基準を
  当てはめると、**push allowlist の実体である `.mrw/workspace.json` が、
  pre-push フック・特権スクリプト・`.worker-target` より弱い保護しか受けていない**
  のは一貫性を欠く。ドリフトか将来の allowWrite 追加(/update-task-sandbox の
  `--add-write` で state_root 配下を広げる等)が起きた瞬間、worker が
  `allowed_push_orgs` を書き換えられる。
- 09-A の「tasks/ 配下 `.mrw/` 偽装」修正は「偽の config を**読ませない**」対策。
  本指摘は「正規の config を**書き換えさせない**」対策で、対になる欠落。

orchestrator 側の denyWrite 列挙(§4.3)にも同様に `.mrw/` がない。

## 改善候補(モードB で採用推奨)

1. プレースホルダに `{{CONFIG_DIR}}` を追加し(render 時に `config_dir()` の解決値)、
   worker / orchestrator 両テンプレートの `filesystem.denyWrite` と
   `permissions.deny`(Edit)に `{{CONFIG_DIR}}/**` を加える。
   legacy モードでは `{{CONFIG_DIR}}` = `<toolHome>/config` に解決され、既存の
   ピンと重複するだけなので後方互換は保たれる。
2. `08-verification.md` Step 2 のチェックリストに
   「worker settings の denyWrite に解決済み config_dir が含まれる」を追加する。
3. `update-task-sandbox.sh` の `--add-write` に対し、config_dir 配下を指定された場合は
   拒否(または明示の二重確認)するガードを仕様に足す。
4. 09-A の「単一 canonicalize+validate」実装時に、`config_dir()` の解決値を
   settings 生成へ渡す配線を同時に作ると自然(同じ解決値を3実装+テンプレートで共有)。

## 補足(重大度の見積り)

現時点の顕在リスクは低い(default-deny が効いている)。ただし
「denyWrite ピンで守る」というこのシステムの自己基準に照らした欠落であり、
将来の allow 追加1つで push ガードが崩れる単一障害点なので High とした。
