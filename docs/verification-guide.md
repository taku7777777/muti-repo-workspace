# Verification guide

How to prove an installation works, end to end. Run these after forking /
customizing, after upgrading Claude Code, or after touching `templates/` or
`scripts/`.

## 0. Unit tests (seconds)

```bash
bash tests/run-tests.sh
```

All helper functions (path homing, template rendering, override precedence,
ticket validation, pre-push org extraction) must pass.

## 1. Setup

```bash
bash scripts/setup-workspace.sh
```

Check:
- every real repo in `config/repos.json` is cloned under `repositories/`
- `.claude/settings.json` and `repositories/.claude/settings.json` exist
- `git config --global --get includeIf.gitdir:<root>/.path` points at
  `<root>/.gitconfig-workspace`
- `~/.cmux-wait.sh` and `~/.cmux-state.sh` exist and are executable
- restart `claude` in the root, accept trust, and confirm there is **no**
  "Ignoring N permissions.allow entries" warning

Root sandbox spot-checks: see [settings-reference/root.md](settings-reference/root.md).

## 2. Task creation (no cmux needed)

```bash
bash scripts/create-workspace.sh --ticket TEST-001 --purpose dev \
  --repos "<a-real-repo>" --title "verify" --phase init --yes
bash scripts/create-workspace.sh --ticket TEST-001 --phase finalize --yes
```

Check under `tasks/TEST-001/`:
- worktree exists, branch `feat/TEST-001` (`git -C tasks/TEST-001/repositories/<repo> branch --show-current`)
- knowledge repos contain only their `sparse_paths.<purpose>` directories
- `agents/{worker,orchestrator}/` each have `CLAUDE.md`, `initial-prompt.md`,
  `.claude/settings.json` (valid JSON: `jq . <file>`), and an empty `.git` file
- worker settings `sandbox.filesystem.allowWrite` does **NOT** include any
  origin `.git` (commits don't need it — S8-d), and `denyWrite` pins, for
  every task repo: `repositories/<repo>/.git/config`, `.../.git/hooks`, and
  the worktree's private gitdir `config.worktree`
  (`git -C tasks/TEST-001/repositories/<repo> rev-parse --absolute-git-dir`
  to see the expected prefix)
- `.task-meta.json` exists at the task root with the correct
  `purpose`/`repos`/`branch` (permanent metadata — `/list-task` and
  add-repository read from it)
- worker settings `permissions.additionalDirectories` lists **only** the task
  dir — no `repositories/` entry at all (origins are intentionally not added;
  S2-o would otherwise widen the OS write boundary to the shared clones)
- **byte-match**: every entry of the orchestrator's
  `sandbox.excludedCommands` (without trailing ` *`) appears verbatim in
  `agents/orchestrator/CLAUDE.md`, and the file at its `~`-expanded path exists

## 3. cmux + agents (live)

Prereq: trust both agent dirs (open-task Step 6.5), then:

```bash
bash scripts/create-workspace.sh --ticket TEST-001 --phase cmux --yes
```

Check:
- cmux workspace `TEST-001` with tabs: Worker Claude / Terminal / Orchestrator Claude
- `.worker-target` contains the workspace UUID + tab-1 surface UUID
- tab 1: worker started reading `docs/task.md`, **no permission warnings**
- worker goes idle after its first handoff report (a file appears in
  `tasks/TEST-001/docs/handoff/`) and does **not** exit

From the orchestrator (tab 3), run the loop once:
- send an instruction (e.g. "add a comment to X and commit")
- `wait-for-worker` in background → `RESULT status=idle`
- newest handoff file readable with the Read tool
- worker committed: `git -C tasks/TEST-001/repositories/<repo> log --oneline -1`

Sandbox spot-checks per role: see
[settings-reference/worker.md](settings-reference/worker.md) /
[settings-reference/orchestrator.md](settings-reference/orchestrator.md).

## 4. Publish path

- orchestrator: `~/.../push-create-pr.sh <repo> --title t --body b`
  - with `allowed_push_orgs` NOT containing the repo's org → pre-push blocks
  - with the org added → push succeeds, PR created (use a scratch repo!)
- worker: `git push` → fails (network)

## 5. Regression traps (the classic failure modes)

| Trap | Expected behavior |
|---|---|
| Calling an excluded script via relative path or `bash <path>` | Exit 126 — only the literal path form works |
| Adding an entry to the **worker's** `excludedCommands` | NEVER do it — `<excluded>; anything` runs the whole line unsandboxed under auto-allow |
| cmux `send` without separate `send-key enter` | text sits unsubmitted — always two events |
| Untrusted agent dir | "Ignoring N permissions.allow entries" → sandbox incomplete; fix trust, restart |
| cmux tab command without `cd <abs path> &&` | session starts in `$HOME` and misses the task settings |
| `git worktree` buried in a sandboxed script | blocked; use direct `git -C` (skill path) or excluded scripts |
| Surface addressed by index/ref instead of UUID | breaks on reorder — `.worker-target` must hold UUIDs |

## 6. Teardown

```bash
bash scripts/remove-workspace.sh TEST-001          # blocks on unpushed work
bash scripts/remove-workspace.sh TEST-001 --force  # after reviewing what's lost
```

Check: worktrees gone (`git -C repositories/<repo> worktree list`), cmux
workspace closed, `tasks/TEST-001` deleted.
