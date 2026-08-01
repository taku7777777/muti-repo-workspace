# Codex レビューフィードバック
日付: 2026-07-17(2026-08-02 の §12.1 移行で遡及付与。値は本文の実施日)

実施日: 2026-07-17  
対象: `/Users/takuto/github/muti-repo-workspace` の現作業ツリー  
観点: 実装妥当性、権限境界、秘密情報、依存関係、テスト、設定・運用上の安全性

## 総合判断

基本設計は堅実である。特に publish broker の fail-closed 設計、承認対象 SHA の再検証、GitHub token を worker から隔離する構成、ブラウザ承認画面の Host/CSRF/CSP 対策、HTML エスケープには妥当性がある。

一方で、現状のまま「すべての利用形態でセキュリティ境界が保証される」とは判断できない。特に次の3点は実運用またはマージ前に修正すべきである。

1. native push 経路における設定解決の不一致
2. ホスト側トリアージがファイル読取ツールを保持していること
3. telemetry ネットワークが internal であることを起動時に検証していないこと

## 指摘事項

### 1. High: native pre-push が誤った設定を参照する可能性

対象:

- `scripts/lib/common.sh:36-60`
- `.githooks/pre-push:25-38`
- `cli/mrw.mjs` の config 解決処理

`common.sh` と `mrw.mjs` は `MRW_CONFIG_DIR` を最優先するが、pre-push hook はこの環境変数を参照せず、push 元 worktree からの親ディレクトリ走査だけで設定を決定する。そのため、コメントで主張されている「3実装が同じ設定を解決する」という不変条件は成立しない。

さらに `state_root` をワークスペース外へ外部化すると、`state_root/tasks/<ticket>/repositories/<repo>` から正規の `<workspace>/.mrw/` へ親方向に到達できない。この場合、pre-push は tool checkout 側の `config/workspace.json` へフォールバックする。

コンテナ経路では broker が別途ポリシーを強制するため直ちに broker を突破する問題ではないが、native push 経路では誤った allowlist、設定欠落時の fail-open が適用され得る。

改善案:

- worktree または origin の信頼済み Git config に、使用する config の絶対・正規化済みパスをセットアップ時に固定する
- pre-push で設定不明、JSON不正、型不正を fail-closed にする
- `MRW_CONFIG_DIR` と `state_root` を `realpath` 相当で正規化し、絶対パス、末尾スラッシュ、symlink、`tasks` セグメントを一貫して検証する
- 3つの設定解決実装に同じケースを与える自動テストを追加する

### 2. High: ホスト側トリアージが Read/Grep/Glob を使用可能

対象:

- `harness/src/triage.ts:59-73`
- `harness/src/sdk.ts` の `baseOptions()` と `READ_ONLY_TOOLS`

トリアージは task workspace 作成前にホスト側で実行されるが、`Read`、`Grep`、`Glob` が許可されている。`cwd` を呼出箇所で明示していなくても、共通設定では `process.cwd()` が使用される。また Read は絶対パスを受け取れるため、cwd を設定しないこと自体はホスト上のファイル読取防止にならない。

敵対的なIssue本文などがプロンプトインジェクションを行った場合、ホスト上の認証情報その他のファイルを読み、その内容を title や summary に混入させる余地がある。

改善案:

- トリアージを `tools: []` とする
- `disallowedTools` でも Read/Grep/Glob を含む全ツールを拒否する
- 空の一時ディレクトリなど、不活性な場所を明示的な cwd にする
- チケット本文を「信頼しないデータ」と明記した開始・終了マーカーで囲む
- title/summary を端末へ表示する前に ANSI/OSC を含む制御文字を除去する
- reviewer と同等の tool-less posture を共通化し、回帰テストを追加する

### 3. High: telemetry ネットワークの internal 属性が未検証

対象:

- `scripts/devcontainer-up.sh:65-71`

現在は次の処理でネットワークを作成している。

```sh
docker network create --internal mrw-telemetry 2>/dev/null || true
```

同名の非internalネットワークが既に存在する場合、作成失敗が `|| true` で無視され、compose は既存ネットワークを使用する。ネットワーク分離をセキュリティ境界とする設計なので、これは fail-open となる。

改善案:

- 作成後に `docker network inspect` で `Internal == true` を必ず検証する
- 存在するが非internalの場合は明示的なエラーで起動を停止する
- doctor/verify に同じ検証を追加する

### 4. Medium: broker policy の単一ファイル bind

対象:

- `.devcontainer/docker-compose.yml:405-415`

`broker-policy.json` を単一ファイルとして bind mount している。エディタが atomic rename で保存した場合、稼働中コンテナが古い inode の内容を参照し続ける可能性がある。また、起動時にホスト側ファイルが存在しなければ、Docker が同名ディレクトリを生成して以後の修正を妨げる場合がある。

改善案:

- 信頼済み config ディレクトリ全体を read-only bind し、その配下の固定パスを `BROKER_POLICY_FILE` として参照する
- compose 起動前に policy が存在する通常ファイルであること、JSON・schema が妥当であることを検証する

### 5. Medium: 複数ワークスペース間で Compose 資源が衝突する

対象:

- `.devcontainer/docker-compose.yml:31`

Compose project name が `mrw-phase0` に固定されている。複数ワークスペースを同時起動すると、コンテナ、ネットワーク、named volume が同一プロジェクトとして共有または再利用される可能性がある。

改善案:

- workspace の正規化済み絶対パスまたは生成UUIDから、一意で安定した project name を作る
- 意図的に共有する telemetry network と、ワークスペースごとに分離する volume/network を明確に分ける
- 並列起動を検証する統合テストを追加する

### 6. Medium: `state_root` と config path の正規化が不十分

対象:

- `scripts/lib/common.sh:36-119`
- `cli/mrw.mjs` の対応処理

`state_root` は絶対パスであることのみ検査され、末尾スラッシュ、symlink、`..`、実体パス、`tasks` セグメントとの関係が正規化されない。これらは Git `includeIf`、sandbox deny path、bind mount source、設定探索のバイト一致に影響する。

改善案:

- config/state path を利用前に単一の正規化処理へ通す
- 存在するパスは `realpath`、未作成パスは正規化した絶対パスとして扱う
- 正規化後の値だけをテンプレート、Git config、compose 環境変数へ渡す
- JSON破損時に暗黙のデフォルトへ戻らず、設定を使う操作は停止する

### 7. Low: root sandbox の外部 state root に対する防御が弱い

対象:

- `templates/root/claude-settings.json:67-79`

`{{STATE_ROOT}}` 全体を `additionalDirectories` に追加しているが、明示的な Edit deny は `/repositories/**` などプロジェクト相対の表記に留まる。外部 state root の絶対パスと一致しない可能性がある。

root は信頼レイヤであるため直ちに権限突破となる問題ではないが、意図した guardrail が外部化モードで後退する。

改善案:

- 生成時に正規化済み `STATE_ROOT/repositories` などの絶対 deny を追加する
- deny が実際の外部パスに適用されることを生成物テストで確認する

### 8. Low: CLI の自動テストと静的解析の拡充

`cli/mrw.mjs` は設定解決、引数変換、プロセス起動、資格情報の引き渡しなど重要な役割を持つ一方、専用の自動テストが見当たらない。また、この環境には ShellCheck がなく、shell script の静的解析を実施できなかった。

改善案:

- config 解決と引数パースを副作用のない関数へ分離してテストする
- `--help`、未知オプション、値を必要とするオプション、外部 state root をテストする
- CI に ShellCheck を追加する
- TypeScriptテストとは別に、compose config と生成テンプレートの整合検査を追加する

## 検証結果

- `tests/run-tests.sh`: 65件成功、失敗0件
- broker / harness / reviewer / serve の全テストスイート: 成功
- broker / harness / reviewer / serve の TypeScript typecheck: 成功
- `npm audit --package-lock-only --omit=dev`: 全4パッケージで既知脆弱性0件
- 秘密鍵、GitHub token、AWS access key、Anthropic/OpenAI形式など代表的な秘密情報パターン: 検出なし
- `.env`、`node_modules`、`.claude/settings.local.json`、`.DS_Store` の追跡: 検出なし
- ShellCheck: 実行環境に未導入のため未実施

最初のローカルテストではサンドボックスがUnixソケットのlistenを拒否したため一部が失敗したが、サンドボックス外で同じテストを再実行し、全件成功を確認した。これは製品コードの失敗ではなく監査実行環境の制約によるものだった。

## 修正優先順位

マージまたは実運用前:

1. pre-push の設定解決を固定し、設定不明時を fail-closed にする
2. ホスト側トリアージを完全に tool-less にする
3. telemetry network の internal 属性を起動時に検証する

次の改善サイクル:

4. broker policy をディレクトリ bind と起動前検証へ変更する
5. Compose project name と named volume をワークスペース単位で分離する
6. path 正規化処理を一本化する

継続的改善:

7. root sandbox の外部パス deny を補強する
8. CLI、shell、compose、生成設定のテストと静的解析を拡充する

## 作業ツリーについて

監査開始時点で次の既存未コミット変更が存在した。

- `review-feedback.md` の削除
- `rebuild-doc/` の新規ファイル群
- `rebuild-doc-fb/` の新規ファイル群
- `review-fb-20260716.md` の新規ファイル

これらは監査では変更していない。本ファイル `review-codexfb-20260716.md` のみを追加した。
