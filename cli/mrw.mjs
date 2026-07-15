#!/usr/bin/env node
// mrw — thin dispatcher CLI over the scripts/ in a muti-repo-workspace tool
// checkout. It resolves its own install location (toolHome) from
// import.meta.url and shells out to the existing, Phase-1-cleaned scripts.
// It does NOT reimplement any logic — see docs/mrw-cli.md for the target
// design and cli/README.md for what is (and isn't) wired up yet.
//
// Plain ESM, Node builtins only. No external dependencies.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// toolHome resolution — ALWAYS from the binary's own location, never from
// process.cwd(), so `mrw` behaves identically no matter where it is invoked
// from. cli/ sits directly under the repo root.
const toolHome = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const WORKSPACE_CONFIG_PATH = path.join(toolHome, "config", "workspace.json");
const REPOS_CONFIG_PATH = path.join(toolHome, "config", "repos.json");

// ---------------------------------------------------------------------------
// small helpers

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// resolveStateRoot — mirrors scripts/lib/common.sh `state_root()`:
//   - read .state_root from config/workspace.json
//   - if non-empty, it MUST be an absolute path (die otherwise)
//   - if empty, default to toolHome (the historical, unconfigured layout)
function resolveStateRoot() {
  const cfg = readJson(WORKSPACE_CONFIG_PATH);
  const sr = cfg.state_root || "";
  if (sr !== "") {
    if (!path.isAbsolute(sr)) {
      console.error(
        `error: config/workspace.json .state_root must be an absolute path (got '${sr}')`
      );
      process.exit(1);
    }
    return sr;
  }
  return toolHome;
}

// setStateRoot — write .state_root into config/workspace.json WITHOUT
// touching anything else in the file: other keys, the `_note` keys, blank
// lines, 2-space indent and the trailing newline must all survive
// byte-for-byte. A wholesale JSON.parse -> JSON.stringify round trip would
// lose the file's hand-formatting (blank lines between groups), so instead
// this does a targeted regex replace of just the "state_root" value on its
// own line.
function setStateRoot(value) {
  const raw = fs.readFileSync(WORKSPACE_CONFIG_PATH, "utf8");
  const lineRe = /^(\s*"state_root"\s*:\s*")([^"]*)("\s*,?\s*)$/m;
  if (!lineRe.test(raw)) {
    console.error(
      `error: could not find a "state_root" key to update in ${WORKSPACE_CONFIG_PATH}`
    );
    process.exit(1);
  }
  // Reuse JSON.stringify to get correct JSON string escaping for the value,
  // then strip the outer quotes it adds.
  const escaped = JSON.stringify(value).slice(1, -1);
  const updated = raw.replace(lineRe, (_m, pre, _old, post) => `${pre}${escaped}${post}`);
  fs.writeFileSync(WORKSPACE_CONFIG_PATH, updated);
}

// runScript — exec a script under toolHome/scripts/, forwarding argv and
// propagating its exit code. stdio is inherited so interactive/streaming
// output (and TTY prompts) pass straight through. `env` defaults to
// process.env (spawnSync's own default) so every existing call site behaves
// byte-for-byte the same; task-up passes an overlay to stamp MRW_WORK_TYPE.
function runScript(relativeScriptPath, argv, env) {
  const scriptPath = path.join(toolHome, "scripts", relativeScriptPath);
  const result = spawnSync(scriptPath, argv, {
    stdio: "inherit",
    cwd: toolHome,
    env: env || process.env,
  });
  handleSpawnResult(result, scriptPath);
}

function runCommand(cmd, argv) {
  const result = spawnSync(cmd, argv, { stdio: "inherit", cwd: toolHome });
  handleSpawnResult(result, cmd);
}

function handleSpawnResult(result, label) {
  if (result.error) {
    console.error(`error: failed to run ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`error: ${label} was killed by signal ${result.signal}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

// ---------------------------------------------------------------------------
// usage

const USAGE = `mrw — thin dispatcher over the muti-repo-workspace scripts/

Usage: mrw <subcommand> [args...]

Subcommands:
  help                                 print this usage
  config [--state-root <abs|"">]       show (or set) toolHome/state_root/repos
  setup [args...]                      exec scripts/setup-workspace.sh
  infra-up [args...]                   exec scripts/devcontainer-up.sh
  infra-down [args...]                 docker compose down (the devcontainer stack)
  task-up --ticket <ID> [opts...]      exec scripts/create-workspace.sh --phase all
    [--from <ref>] [--body-file <path>] [--no-triage]
                                        --from fetches a ticket body via
                                        scripts/lib/ticket-sources/<ticket_source>.sh;
                                        --body-file reads it from a local file
                                        instead. Unless --no-triage, a fetched
                                        body is auto-triaged (bounded, read-only
                                        Claude classifier) to pre-fill --title/
                                        --repos; explicit flags always win.
  list [args...]                       exec scripts/list-task.sh
  close <TICKET_ID> [--force]          exec scripts/remove-workspace.sh
  doctor [args...]                     exec scripts/verify-workspace.sh

toolHome resolves from mrw's own install location (works from any cwd).
See cli/README.md for details and deferred items.
`;

function printUsage() {
  process.stdout.write(USAGE);
}

// ---------------------------------------------------------------------------
// subcommands

function cmdConfig(argv) {
  let stateRootFlagSeen = false;
  let newValue = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--state-root") {
      stateRootFlagSeen = true;
      if (i + 1 >= argv.length) {
        console.error("error: --state-root requires a value (an absolute path, or \"\" to clear it)");
        process.exit(1);
      }
      newValue = argv[++i];
    } else {
      console.error(`error: mrw config: unrecognized argument '${argv[i]}'`);
      printUsage();
      process.exit(2);
    }
  }

  if (stateRootFlagSeen) {
    if (newValue !== "" && !path.isAbsolute(newValue)) {
      console.error(
        `error: --state-root must be an absolute path (got '${newValue}'). Pass "" to clear it back to the default.`
      );
      process.exit(1);
    }
    setStateRoot(newValue);
    if (newValue === "") {
      console.log(`state_root cleared — back to the default (tool checkout: ${toolHome})`);
    } else {
      console.log(`state_root set to: ${newValue}`);
    }
  }

  const cfg = readJson(WORKSPACE_CONFIG_PATH);
  const stateRoot = resolveStateRoot();
  const isDefault = (cfg.state_root || "") === "";
  const repos = readJson(REPOS_CONFIG_PATH);
  const repoNames = (repos.repositories || []).map((r) => r.name);

  console.log(`toolHome:   ${toolHome}`);
  console.log(
    `state_root: ${stateRoot} (${isDefault ? "default — unset in config/workspace.json, == toolHome" : "external — set in config/workspace.json"})`
  );
  console.log(`repos:      ${repoNames.length ? repoNames.join(", ") : "(none)"}`);
}

// task-up argument handling: map --url -> --ticket-url, accept a bare
// positional as the ticket ID when --ticket is omitted, and refuse a bare
// URL positional with no ID (use --from <ref> for link-based triage).
//
// `defaults` (optional) carries triage-derived fallbacks computed by
// cmdTaskUp: { ticketId, title, repos, ticketUrl }. Any explicit flag in
// `argv` always wins; a default is only forwarded when the corresponding
// flag was NOT supplied by the caller. Called with no `defaults` (the plain
// slice-1 path), behavior is byte-for-byte unchanged from before.
function buildTaskUpArgs(argv, defaults = {}) {
  const VALUE_FLAGS = new Set([
    "--ticket",
    "--repos",
    "--title",
    "--purpose",
    "--url",
    "--ticket-url",
    "--dev-kind",
  ]);
  const BOOL_FLAGS = new Set(["--no-sandbox", "--sandbox", "--yes", "--skip-worktrees"]);

  let ticketId = null;
  let titleSeen = false;
  let reposSeen = false;
  let urlSeen = false;
  const forwarded = [];
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phase") {
      // task-up always drives the full lifecycle; a caller-supplied --phase
      // would silently override that, so it is dropped rather than forwarded.
      console.error("warning: --phase is ignored by 'mrw task-up' (always runs --phase all)");
      i++;
      continue;
    }
    if (a === "--ticket") {
      if (i + 1 >= argv.length) {
        console.error("error: --ticket requires a value");
        process.exit(1);
      }
      ticketId = argv[++i];
      continue;
    }
    if (a === "--url") {
      if (i + 1 >= argv.length) {
        console.error("error: --url requires a value");
        process.exit(1);
      }
      urlSeen = true;
      forwarded.push("--ticket-url", argv[++i]);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) {
        console.error(`error: ${a} requires a value`);
        process.exit(1);
      }
      const value = argv[++i];
      if (a === "--title") titleSeen = true;
      if (a === "--repos") reposSeen = true;
      if (a === "--ticket-url") urlSeen = true;
      forwarded.push(a, value);
      continue;
    }
    if (BOOL_FLAGS.has(a) || a === "-h" || a === "--help") {
      forwarded.push(a);
      continue;
    }
    if (a.startsWith("-")) {
      // Unknown flag: forward verbatim, unchanged (pass-through).
      forwarded.push(a);
      continue;
    }
    positionals.push(a);
  }

  if (ticketId === null) {
    if (positionals.length > 0) {
      const first = positionals[0];
      if (/^https?:\/\//i.test(first)) {
        console.error(
          `error: pass --ticket <ID> (or use --from '${first}' for link-based triage) — a bare link positional is not accepted`
        );
        process.exit(1);
      }
      ticketId = first;
      forwarded.push(...positionals.slice(1));
    }
  } else {
    forwarded.push(...positionals);
  }

  // Triage-derived fallbacks: only when the caller did not already say so.
  if (ticketId === null && defaults.ticketId) {
    ticketId = defaults.ticketId;
  }
  if (!titleSeen && defaults.title) {
    forwarded.push("--title", defaults.title);
  }
  if (!reposSeen && defaults.repos) {
    forwarded.push("--repos", defaults.repos);
  }
  if (!urlSeen && defaults.ticketUrl) {
    forwarded.push("--ticket-url", defaults.ticketUrl);
  }

  if (ticketId === null) {
    console.error(
      "error: mrw task-up requires --ticket <ID> (or a positional ticket ID, or a --from ref this workspace's ticket_source can derive one from)"
    );
    process.exit(1);
  }

  return ["--phase", "all", "--ticket", ticketId, ...forwarded];
}

// ---------------------------------------------------------------------------
// task-up triage wiring
//
// `mrw task-up --from/--body-file` fetches a ticket body and, unless
// --no-triage, runs it through the harness's bounded read-only triage leaf
// (harness/src/triage.ts) to pre-fill --title/--repos and record work_type.
// Every failure mode here (no gh, no credential, triage API/parse failure)
// is GRACEFUL: it warns to stderr and falls through to creating the task
// without triage. The one exception is an explicit --from fetch itself
// failing — the user asked for that fetch, so that IS a hard error (see
// fetchTicketBody below). mrw stays dependency-free plain ESM throughout:
// no zod here, just a light shape check on the harness's JSON stdout.

// resolveTicketSourceScript — scripts/lib/ticket-sources/<ticket_source>.sh,
// where <ticket_source> comes from config/workspace.json (.ticket_source).
function resolveTicketSourceScript() {
  const cfg = readJson(WORKSPACE_CONFIG_PATH);
  const source = cfg.ticket_source || "manual";
  const scriptPath = path.join(toolHome, "scripts", "lib", "ticket-sources", `${source}.sh`);
  if (!fs.existsSync(scriptPath)) {
    console.error(
      `error: unknown ticket_source '${source}' (config/workspace.json) — no adapter at ${scriptPath}`
    );
    process.exit(1);
  }
  return scriptPath;
}

// fetchTicketBody — run the ticket_source adapter's `fetch <ref>` contract
// (see scripts/lib/ticket-sources/{github-issues,manual}.sh). An explicit
// --from was a direct user request, so a failed fetch (missing gh, bad ref,
// adapter error) is a HARD failure here — this does not go through the
// triage graceful-degradation path.
function fetchTicketBody(ref) {
  const scriptPath = resolveTicketSourceScript();
  const result = spawnSync(scriptPath, ["fetch", ref], { encoding: "utf8", cwd: toolHome });
  if (result.error) {
    console.error(`error: failed to run ticket source adapter '${scriptPath}': ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`error: fetching ticket body for '${ref}' failed (adapter exited ${result.status}).`);
    const stderrTail = (result.stderr || "").trim();
    if (stderrTail) console.error(`  ${stderrTail}`);
    console.error("  (fetch failed — is 'gh' installed and authenticated, if using the github-issues adapter?)");
    process.exit(1);
  }
  return result.stdout;
}

// readBodyFileOrDie — --body-file is also a direct user request, so an
// unreadable file is a hard error (mirrors fetchTicketBody's posture).
function readBodyFileOrDie(bodyFilePath) {
  try {
    return fs.readFileSync(bodyFilePath, "utf8");
  } catch (err) {
    console.error(`error: could not read --body-file '${bodyFilePath}': ${err.message}`);
    process.exit(1);
  }
}

// ensureClaudeCredentialEnv — resolve an env overlay carrying a Claude
// credential for the triage subprocess, WITHOUT mutating process.env:
//   - an already-set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY wins as-is
//     (overlay is {} — nothing to add).
//   - otherwise try the macOS Keychain entry devcontainer-up.sh also reads
//     (`security find-generic-password -s claude-code-oauth-token -w`).
//   - returns null when no credential is available at all — the caller
//     treats that as "skip triage", never a hard failure.
function ensureClaudeCredentialEnv() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return {};
  }
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", "claude-code-oauth-token", "-w"],
    { encoding: "utf8" }
  );
  if (!result.error && result.status === 0 && result.stdout && result.stdout.trim()) {
    return { CLAUDE_CODE_OAUTH_TOKEN: result.stdout.trim() };
  }
  return null;
}

// runTriageStep — invoke the harness triage leaf as a subprocess and parse
// its stdout. Every failure path WARNS and returns null (graceful
// degradation); it never throws or exits the process.
function runTriageStep(bodyText, availableRepos, credEnv) {
  const harnessDir = path.join(toolHome, "harness");
  const result = spawnSync(
    "npm",
    ["--prefix", harnessDir, "run", "-s", "triage", "--", "--repos", availableRepos.join(",")],
    {
      input: bodyText,
      encoding: "utf8",
      env: { ...process.env, ...credEnv },
      cwd: toolHome,
    }
  );
  if (result.error) {
    console.error(`warning: triage step failed to run (${result.error.message}) — proceeding without triage.`);
    return null;
  }
  if (result.status !== 0) {
    console.error(`warning: triage step exited ${result.status} — proceeding without triage.`);
    const stderrTail = (result.stderr || "").trim();
    if (stderrTail) console.error(`  ${stderrTail.split("\n").slice(-5).join("\n  ")}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse((result.stdout || "").trim());
  } catch (err) {
    console.error(`warning: triage produced unparseable output — proceeding without triage. (${err.message})`);
    return null;
  }
  const validShape =
    parsed &&
    typeof parsed === "object" &&
    typeof parsed.work_type === "string" &&
    typeof parsed.title === "string" &&
    Array.isArray(parsed.repos) &&
    parsed.repos.every((r) => typeof r === "string") &&
    typeof parsed.summary === "string";
  if (!validShape) {
    console.error("warning: triage output did not match the expected shape — proceeding without triage.");
    return null;
  }
  return parsed;
}

// deriveGithubIssueId — best-effort GH-<N> ticket ID from a github-issues
// style ref (URL or org/repo#N), matching the default ticket_id_pattern
// (^[A-Z]+-...). Only used as a LAST-RESORT default (--ticket / a positional
// ID always win — see buildTaskUpArgs).
function deriveGithubIssueId(ref) {
  const urlMatch = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)(?:[/?#].*)?$/i.exec(ref);
  if (urlMatch) return `GH-${urlMatch[1]}`;
  const shortMatch = /^[^/\s]+\/[^/\s]+#(\d+)$/.exec(ref);
  if (shortMatch) return `GH-${shortMatch[1]}`;
  return null;
}

// cmdTaskUp — owns --from/--body-file/--no-triage, then delegates the rest
// of argv (with triage-derived defaults) to buildTaskUpArgs.
function cmdTaskUp(argvIn) {
  let fromRef = null;
  let bodyFile = null;
  let noTriage = false;
  const rest = [];

  for (let i = 0; i < argvIn.length; i++) {
    const a = argvIn[i];
    if (a === "--from") {
      if (i + 1 >= argvIn.length) {
        console.error("error: --from requires a value");
        process.exit(1);
      }
      fromRef = argvIn[++i];
      continue;
    }
    if (a === "--body-file") {
      if (i + 1 >= argvIn.length) {
        console.error("error: --body-file requires a value");
        process.exit(1);
      }
      bodyFile = argvIn[++i];
      continue;
    }
    if (a === "--no-triage") {
      noTriage = true;
      continue;
    }
    rest.push(a);
  }

  // 1. Resolve ticket body text: --body-file > --from (adapter fetch) > none.
  let bodyText = null;
  if (bodyFile) {
    bodyText = readBodyFileOrDie(bodyFile);
  } else if (fromRef) {
    bodyText = fetchTicketBody(fromRef);
  }

  // ID / ticket-url defaults derived from --from, independent of whether it
  // supplied the body text (e.g. --body-file + --from together: the file is
  // the body, the ref is still used for ID/url derivation).
  const defaults = {};
  if (fromRef) {
    const derivedId = deriveGithubIssueId(fromRef);
    if (derivedId) defaults.ticketId = derivedId;
    if (/^https?:\/\//i.test(fromRef)) defaults.ticketUrl = fromRef;
  }

  // 2. Triage — opt-in-by-default whenever a body is available.
  let triage = null;
  if (bodyText && !noTriage) {
    const credEnv = ensureClaudeCredentialEnv();
    if (credEnv === null) {
      console.error(
        "warning: no Claude credential available (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY not set, " +
          "and the macOS Keychain has no 'claude-code-oauth-token' entry) — skipping triage."
      );
    } else {
      const repos = readJson(REPOS_CONFIG_PATH);
      const availableRepos = (repos.repositories || []).map((r) => r.name);
      triage = runTriageStep(bodyText, availableRepos, credEnv);
    }
  }

  if (triage) {
    defaults.title = triage.title;
    if (triage.repos.length > 0) defaults.repos = triage.repos.join(",");
    console.log("triage summary:");
    console.log(`  work_type: ${triage.work_type}`);
    console.log(`  title:     ${triage.title}`);
    console.log(`  repos:     ${triage.repos.length ? triage.repos.join(", ") : "(none)"}`);
    console.log(`  summary:   ${triage.summary}`);
  }

  // 6. task.md: deliberately NOT written here. create-workspace.sh's own
  // finalize phase scaffolds docs/task.md from a template only if the file
  // doesn't already exist; racing that (writing it here, before or after)
  // risks fighting its own scaffolding (order-of-phases, --phase-only reruns,
  // idempotency). Simplest and safest: leave task.md to create-workspace and
  // just tell the operator the body was fetched, so they can paste it in.
  if (bodyText) {
    console.log(
      "note: fetched ticket body was NOT written to docs/task.md (left to create-workspace's own " +
        "scaffolding) — paste it in manually if you want it recorded there."
    );
  }

  // 3. Determine create-workspace.sh's argv (explicit flags win over
  // defaults; see buildTaskUpArgs).
  const forwardedArgs = buildTaskUpArgs(rest, defaults);

  // 5. MRW_WORK_TYPE is stamped into create-workspace.sh's own env only —
  // this is a per-run record, NOT per-ticket telemetry wiring (the stack's
  // OTEL_RESOURCE_ATTRIBUTES work_type is currently stack-level; see
  // telemetry.ts's header and cli/README.md's deferred items).
  const env = { ...process.env };
  if (triage) env.MRW_WORK_TYPE = triage.work_type;

  runScript("create-workspace.sh", forwardedArgs, env);
}

// ---------------------------------------------------------------------------
// main

function main() {
  const argv = process.argv.slice(2);
  const [sub, ...rest] = argv;

  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    printUsage();
    process.exit(0);
  }

  switch (sub) {
    case "config":
      cmdConfig(rest);
      break;

    case "setup":
      runScript("setup-workspace.sh", rest);
      break;

    case "infra-up":
      runScript("devcontainer-up.sh", rest);
      break;

    case "infra-down":
      runCommand("docker", ["compose", "-f", ".devcontainer/docker-compose.yml", "down", ...rest]);
      break;

    case "task-up":
      cmdTaskUp(rest);
      break;

    case "list":
      runScript("list-task.sh", rest);
      break;

    case "close":
      runScript("remove-workspace.sh", rest);
      break;

    case "doctor":
      runScript("verify-workspace.sh", rest);
      break;

    default:
      console.error(`error: unknown subcommand '${sub}'\n`);
      printUsage();
      process.exit(2);
  }
}

main();
