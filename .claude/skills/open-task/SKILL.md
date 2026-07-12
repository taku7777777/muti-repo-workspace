---
name: open-task
description: Create a per-ticket task workspace — git worktrees for the selected repositories, sandboxed worker + orchestrator Claude agents, and a 3-tab cmux workspace. Main entry point for starting work on a ticket.
---

# open-task

Creates `tasks/<TICKET_ID>/` with everything needed for autonomous work.
Backend: `scripts/create-workspace.sh` (phases: init → finalize → cmux).

## Step 1 — Ticket

Get the ticket ID (argument, or ask). It must match `ticket_id_pattern` in
`config/workspace.json` (default `^[A-Z]+-[A-Za-z0-9_-]+$`). Never invent or
auto-add a prefix.

Fetch the ticket content according to `ticket_source` in
`config/workspace.json`:
- `manual` — ask the user to paste the ticket description (or provide a title).
- `github-issues` — run `bash scripts/lib/ticket-sources/github-issues.sh fetch <id-or-url>`
  and use its stdout as the ticket body.
- anything else — run `bash scripts/lib/ticket-sources/<source>.sh fetch <ref>`.

## Step 2 — Purpose (and kind)

List available purposes (`ls config/purposes/*.json`) and let the user pick
one with AskUserQuestion (descriptions come from each file's `description`).
If the chosen purpose defines `dev_kinds`, ask which kind applies.

## Step 3 — Repositories (ALWAYS confirm)

Start from the purpose's `default_repos`, then let the user adjust. Offer the
remaining repos from `config/repos.json` — AskUserQuestion allows max 4
options, so page through them ("3 most relevant + Other") with multiSelect.
The final list is passed explicitly via `--repos`; there is no `--preset`.

## Step 4 — init

```bash
bash scripts/create-workspace.sh --ticket <T> --purpose <p> [--dev-kind <k>] \
  --repos "<a,b,c>" --title "<title>" [--ticket-url "<url>"] --phase init --yes
```

Fails fast on unknown purpose/repos or un-cloned repos.

## Step 5 — task.md + worktrees (you do this part)

**5a. `tasks/<T>/docs/task.md`**: CREATE this file yourself with the FULL
ticket body from Step 1, following the heading structure of the purpose's
`task.md` template (`templates/purposes/<p>/task.md` or
`templates/default/task.md`). It does not exist yet at this point — finalize
(Step 6) only scaffolds it when missing, so a file you write here is kept
as-is. The worker starts from this file with no other context — it must be
self-contained.

**5b. Worktrees** — create them yourself with direct git commands.
(Note: `worktree add` itself is sandbox-compatible — it only writes
`.git/worktrees/`, unlike `git init`/`clone` which are always blocked
(verified S8-c vs S8-a). Direct execution is simply the tested, working
path here; if a wrapped/scripted run fails with EPERM, use direct
commands rather than widening anything.) CRITICAL rules:
- Always `git -C repositories/<repo> ...` from the workspace root; never `cd`.
- Target path must be RELATIVE: `../../tasks/<T>/repositories/<repo>`.
- One command per Bash call — no `&&`, no `;`.
- Branch: `<branch_prefix><T>` (see config/workspace.json, default `feat/<T>`).

Decision per repo:
```bash
# if local branch exists:
git -C repositories/<repo> worktree add ../../tasks/<T>/repositories/<repo> <branch>
# else if origin/<branch> exists:
git -C repositories/<repo> worktree add --track -b <branch> ../../tasks/<T>/repositories/<repo> origin/<branch>
# else (new branch from HEAD):
git -C repositories/<repo> worktree add -b <branch> ../../tasks/<T>/repositories/<repo>
```

For `type: knowledge` repos add `--no-checkout`, then:
```bash
git -C tasks/<T>/repositories/<repo> sparse-checkout set --cone <paths from repos.json sparse_paths.<purpose>>
git -C tasks/<T>/repositories/<repo> checkout <branch>
```

## Step 6 — finalize

```bash
bash scripts/create-workspace.sh --ticket <T> --phase finalize --skip-worktrees --yes
```

Generates agent dirs (worker/orchestrator CLAUDE.md + sandbox settings +
per-task skills), copies privileged scripts, selects MCP servers by purpose.

## Step 6.5 — Trust (required BEFORE starting the agents)

Without trust, Claude Code ignores `permissions.allow` entries and the
sandbox setup is incomplete. Set it for both agent dirs by editing
`~/.claude.json` directly with jq (one Bash call per dir; the permission
prompt you get is expected — approve it):

```bash
jq --arg p "<abs path to tasks/<T>/agents/worker>" '.projects[$p] = ((.projects[$p] // {}) + {hasTrustDialogAccepted: true})' ~/.claude.json > /tmp/claude.json.tmp && mv /tmp/claude.json.tmp ~/.claude.json
```

(repeat for `agents/orchestrator`)

## Step 7 — cmux tabs

```bash
bash scripts/create-workspace.sh --ticket <T> --phase cmux --yes
```

Creates the cmux workspace named `<T>`: Tab 1 "Worker Claude" (auto-starts on
the initial prompt), Tab 2 "Terminal", Tab 3 "Orchestrator Claude". Pins the
worker surface UUID into the orchestrator's `.worker-target`. Without cmux it
prints (and copies) manual startup commands instead.

## Step 8 — Report

Tell the user:
- what was created (task dir, worktrees + branches, agents, tabs);
- initial project setup (dependency install, docker, first build) is THEIR job
  in the Terminal tab — the worker assumes existing deps;
- the worker is already working; watch tab 1, or drive via tab 3.
