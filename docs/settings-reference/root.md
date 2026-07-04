# Settings reference — Root layer

Generated file: `.claude/settings.json` (gitignored)
Template (source of truth): `templates/root/claude-settings.json`
Regenerate with: `/setup-workspace`

## Expectations

| Aspect | Value | Why |
|---|---|---|
| `env.OTEL_RESOURCE_ATTRIBUTES` | `workspace=ROOT` | cost attribution |
| Sandbox | enabled, `allowUnsandboxedCommands: false`, `excludedCommands: []` | root has no unsandboxed escape |
| Network | allow `github.com`, `api.github.com`, `codeload.github.com`, `registry.npmjs.org`; deny `uploads.github.com` | clones, gh api, npm; uploads blocked as exfiltration hedge |
| Bash no-prompt | read-only whitelist: `ls cat find grep rg echo printf mkdir jq gh` + read-only git (`status log diff branch worktree list`) | inspection is free; mutation prompts |
| Bash prompt (`ask`) | `git push *`, `rm *` (everything not allowed prompts anyway) | destructive ops always visible |
| Tool denies | `Edit(/repositories/**)` (origin protection), `Edit(/.claude/**)` (self-protection), `Edit(~/.claude.json)` | settings & sources can't be edited by tools |
| Secret reads | denied twice: sandbox `filesystem.denyRead` + `credentials.files` deny + `permissions.deny Read(...)` for `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.config/gcloud`, `~/.npmrc` | both bash and tool paths blocked |
| `~/.claude.json` | tool-Edit denied, but **bash writes are allowed with a prompt** | the open-task trust step (Step 6.5) writes it via jq with explicit human approval |

## Trust

`permissions.allow` in a project `.claude/settings.json` is ignored until the
directory is trusted (Claude Code prints "Ignoring N permissions.allow
entries"). After /setup-workspace, restart `claude` in the workspace root and
accept the trust dialog.

## Verification quick checks

- `cat ~/.ssh/id_ed25519` → must fail (`Operation not permitted`)
- `curl https://example.com` → must fail (domain not allowed)
- Edit tool on `repositories/<repo>/README.md` → must be denied
- `ls`, `jq . config/repos.json`, `gh pr list` → no prompt
