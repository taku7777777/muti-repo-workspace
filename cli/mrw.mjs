#!/usr/bin/env node
// mrw — thin dispatcher CLI over the scripts/ in a muti-repo-workspace tool
// checkout. It resolves its own install location (toolHome) from
// import.meta.url and shells out to the existing, Phase-1-cleaned scripts.
// It does NOT reimplement any logic — see docs/mrw-cli.md for the target
// design and cli/README.md for what is (and isn't) wired up yet.
//
// Plain ESM, Node builtins only. No external dependencies.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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

// ---------------------------------------------------------------------------
// config_dir resolution — agrees with scripts/lib/common.sh. The pre-push
// hook normally reads this canonical value from scoped git config; walk-up is
// retained there and here for legacy/re-setup compatibility. Priority:
//   1. $MRW_CONFIG_DIR if set and non-empty.
//   2. the nearest ancestor .mrw/ directory (one that CONTAINS
//      workspace.json), found by walking UP from process.cwd() to "/".
//   3. <toolHome>/config (legacy / single-workspace default).
// "workspace mode" = resolved via (1) or (2); "legacy mode" = resolved via (3).
// A path segment named exactly "tasks" marks worker-writable state
// (state_root/tasks/**). We never resolve config from there — see the SECURITY
// note in scripts/lib/common.sh's _config_resolve. Must match the shell +
// pre-push walk-ups exactly.
function underTasksSegment(dir) {
  return dir.split(path.sep).includes("tasks");
}

export function canonicalizePath(input) {
  if (!path.isAbsolute(input)) throw new Error(`path must be absolute (got '${input}')`);
  let candidate = input;
  const missing = [];
  while (true) {
    try {
      // Match canonicalize_path(): only an existing directory terminates the
      // search. A regular file is part of the preserved suffix, even though
      // realpathSync() itself would accept it.
      if (fs.statSync(candidate).isDirectory()) {
        const real = fs.realpathSync(candidate);
        return path.join(real, ...missing);
      }
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(`cannot canonicalize path '${input}'`);
    const part = path.basename(candidate);
    if (part === "..") {
      throw new Error(`cannot canonicalize path with '..' in a missing suffix: '${input}'`);
    }
    if (part !== "." && part !== "") missing.unshift(part);
    candidate = parent;
  }
}

function validateConfigDir(dir) {
  const canonical = canonicalizePath(dir);
  if (underTasksSegment(canonical)) {
    throw new Error(`refusing config directory under a 'tasks/' path segment (${canonical})`);
  }
  const workspaceConfig = path.join(canonical, "workspace.json");
  if (fs.existsSync(workspaceConfig)) readJson(workspaceConfig);
  return canonical;
}

function findAncestorConfigDir() {
  let d = process.cwd();
  while (d !== "/") {
    if (!underTasksSegment(d) && fs.existsSync(path.join(d, ".mrw", "workspace.json"))) {
      return validateConfigDir(path.join(d, ".mrw"));
    }
    d = path.dirname(d);
  }
  return null;
}

function resolveConfigDir() {
  const legacyDir = canonicalizePath(path.join(toolHome, "config"));
  const rawDir = process.env.MRW_CONFIG_DIR || findAncestorConfigDir() || legacyDir;
  const dir = validateConfigDir(rawDir);
  // Mode is determined by VALUE, not by which priority branch produced it —
  // mirrors scripts/lib/common.sh's _config_resolve(). This matters because
  // runScript() below always forwards MRW_CONFIG_DIR=configDir to every
  // spawned script, including in the legacy case (configDir === legacyDir);
  // the child's own config_mode() must still report "legacy" then, so it
  // AGREES with this process rather than seeing "env var is set" and
  // concluding "workspace".
  const mode = dir === legacyDir ? "legacy" : "workspace";
  return { dir, mode };
}

const { dir: configDir, mode: configMode } = resolveConfigDir();

const WORKSPACE_CONFIG_PATH = path.join(configDir, "workspace.json");
const REPOS_CONFIG_PATH = path.join(configDir, "repos.json");

// ---------------------------------------------------------------------------
// small helpers

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// resolveConfigBase — mirrors scripts/lib/common.sh `config_base()`:
// workspace mode ⇒ dirname(configDir) (the dir that HOLDS .mrw/); legacy
// mode ⇒ toolHome.
function resolveConfigBase() {
  return canonicalizePath(configMode === "workspace" ? path.dirname(configDir) : toolHome);
}

function composeProjectName() {
  if (configMode === "legacy") return "mrw-phase0";
  const digest = crypto.createHash("sha256").update(resolveConfigBase()).digest("hex").slice(0, 12);
  return `mrw-${digest}`;
}

// resolveStateRoot — mirrors scripts/lib/common.sh `state_root()`:
//   - read .state_root from configDir/workspace.json
//   - if non-empty, it MUST be an absolute path (die otherwise)
//   - if empty, default to resolveConfigBase() (toolHome in legacy mode —
//     the historical, unconfigured layout)
function resolveStateRoot() {
  const cfg = fs.existsSync(WORKSPACE_CONFIG_PATH) ? readJson(WORKSPACE_CONFIG_PATH) : {};
  const sr = cfg.state_root || "";
  if (sr !== "") {
    if (!path.isAbsolute(sr)) {
      console.error(
        `error: ${WORKSPACE_CONFIG_PATH} .state_root must be an absolute path (got '${sr}')`
      );
      process.exit(1);
    }
    return canonicalizePath(sr);
  }
  return canonicalizePath(resolveConfigBase());
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
// MRW_CONFIG_DIR is ALWAYS added on top of whatever env is used (overriding
// any inherited value) so the spawned script's own config_dir() walk-up
// (which runs with cwd=toolHome, see below — NOT the caller's original cwd)
// agrees with the configDir this CLI process itself discovered, rather than
// relying on the script's independent walk-up landing on the same place.
// `onSuccess` (optional) runs BEFORE the process exits, only when the child
// exited 0 — used by cmdTaskUp to print the 'mrw chat' hint after a
// successful task-up without disturbing any other call site's behavior
// (every other caller omits it, so handleSpawnResult's default path is
// byte-identical to before this parameter existed).
function runScript(relativeScriptPath, argv, env, onSuccess) {
  const scriptPath = path.join(toolHome, "scripts", relativeScriptPath);
  const baseEnv = env || process.env;
  const result = spawnSync(scriptPath, argv, {
    stdio: "inherit",
    cwd: toolHome,
    env: { ...baseEnv, MRW_CONFIG_DIR: configDir },
  });
  handleSpawnResult(result, scriptPath, onSuccess);
}

function runCommand(cmd, argv, env = process.env) {
  const result = spawnSync(cmd, argv, {
    stdio: "inherit",
    cwd: toolHome,
    env: { ...env, MRW_CONFIG_DIR: configDir, COMPOSE_PROJECT_NAME: composeProjectName() },
  });
  handleSpawnResult(result, cmd);
}

function handleSpawnResult(result, label, onSuccess) {
  if (result.error) {
    console.error(`error: failed to run ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`error: ${label} was killed by signal ${result.signal}`);
    process.exit(1);
  }
  const code = result.status === null ? 1 : result.status;
  if (code === 0 && onSuccess) onSuccess();
  process.exit(code);
}

// ---------------------------------------------------------------------------
// usage

const USAGE = `mrw — thin dispatcher over the muti-repo-workspace scripts/

Usage: mrw <subcommand> [args...]

Subcommands:
  help                                 print this usage
  config [--state-root <abs|"">]       show (or set) toolHome/config_dir/state_root/repos
  init [dir]                           scaffold a per-workspace config at <dir>/.mrw/
                                        (default cwd); copies workspace.json, repos.json,
                                        purposes/, broker-policy.json, serve.json (+
                                        serve.css if present) from <toolHome>/config.
                                        Refuses if <dir>/.mrw/ already exists.
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
  chat <TICKET_ID> [opts...]           exec scripts/chat-up.sh — Thread C chat frontend
    [--repos a,b] [--purpose p]        (docs/mrw-chat.md): renders the generated Claude
    [--resume] [instruction...]        Code frontend config, runs spine-prepare, and opens
                                        an interactive session inside the orchestrator
                                        container. Container-only — refuses if the
                                        devcontainer stack is not up. --resume reopens the
                                        same ticket with 'claude --continue' instead of
                                        re-rendering/re-preparing.
  serve [up|down|url|status]           Thread B browser approval (docs/browser-approval.md)
    [--port N] [--no-open]             default 'up': starts the profile-gated 'serve'
                                        compose service (--no-deps, so a running broker is
                                        never recreated), mints a fresh session token, and
                                        prints (and on macOS opens) a tokened
                                        http://localhost:<port>/?token=<token> URL.
                                        'down' stops it; 'url' reprints the URL for an
                                        already-running container; 'status' is compose ps.

toolHome resolves from mrw's own install location (works from any cwd).
config_dir resolves from $MRW_CONFIG_DIR, else the nearest ancestor .mrw/
(walking up from cwd), else <toolHome>/config (legacy default).
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
      console.log(`state_root cleared — back to the default (${resolveConfigBase()})`);
    } else {
      console.log(`state_root set to: ${newValue}`);
    }
    console.log("Re-run `mrw setup` to apply the change (re-bakes the git-config include).");
  }

  const cfg = fs.existsSync(WORKSPACE_CONFIG_PATH) ? readJson(WORKSPACE_CONFIG_PATH) : {};
  const stateRoot = resolveStateRoot();
  const isDefault = (cfg.state_root || "") === "";
  const repos = fs.existsSync(REPOS_CONFIG_PATH) ? readJson(REPOS_CONFIG_PATH) : { repositories: [] };
  const repoNames = (repos.repositories || []).map((r) => r.name);

  console.log(`toolHome:   ${toolHome}`);
  console.log(
    `config_dir: ${configDir} (${configMode === "workspace" ? "workspace mode — per-workspace .mrw/" : "legacy — unset, == toolHome/config"})`
  );
  console.log(
    `state_root: ${stateRoot} (${isDefault ? `default — unset in ${WORKSPACE_CONFIG_PATH}, == config base` : `external — set in ${WORKSPACE_CONFIG_PATH}`})`
  );
  console.log(`compose_project: ${composeProjectName()}`);
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
      if (i + 1 >= argv.length) {
        console.error("error: --phase requires a value");
        process.exit(1);
      }
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
  return {
    ...parsed,
    work_type: stripControlChars(parsed.work_type),
    title: stripControlChars(parsed.title),
    summary: stripControlChars(parsed.summary),
    repos: parsed.repos.map(stripControlChars),
  };
}

export function stripControlChars(value) {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
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
  if (argvIn.includes("-h") || argvIn.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
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
  // buildTaskUpArgs's return shape is always ["--phase", "all", "--ticket", <id>, ...] —
  // pull the resolved ticket id back out for the post-success hint below
  // rather than re-deriving it (ticketId/defaults.ticketId/positionals are
  // all folded together inside buildTaskUpArgs; this index is the one place
  // the FINAL resolved value comes back out).
  const resolvedTicketId = forwardedArgs[3];

  // 5. MRW_WORK_TYPE is stamped into create-workspace.sh's own env only —
  // this is a per-run record, NOT per-ticket telemetry wiring (the stack's
  // OTEL_RESOURCE_ATTRIBUTES work_type is currently stack-level; see
  // telemetry.ts's header and cli/README.md's deferred items).
  const env = { ...process.env };
  if (triage) env.MRW_WORK_TYPE = triage.work_type;

  // docs/mrw-chat.md Phase C3 "Wiring": task-up PRINTS the chat hint — it
  // never auto-launches (that's an explicit `mrw chat` call, and it's
  // container-only besides).
  runScript("create-workspace.sh", forwardedArgs, env, () => {
    console.log("");
    console.log(`Tip: chat with the spine for this ticket — mrw chat ${resolvedTicketId}`);
  });
}

// ---------------------------------------------------------------------------
// mrw init — scaffold a new per-workspace .mrw/ config directory, seeded
// from toolHome's own config/ as a starting point. Purely a file copy: it
// does not touch any generated state (repositories/, tasks/) and does not
// run setup. Refuses to clobber an existing <dir>/.mrw/.
function copyDirFlat(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(destDir, entry));
    }
  }
}

function cmdInit(argv) {
  const targetDir = path.resolve(argv[0] || process.cwd());
  const mrwDir = path.join(targetDir, ".mrw");

  // SECURITY: refuse to scaffold a workspace config inside worker-writable
  // state (a tasks/ segment). config resolution deliberately ignores any
  // .mrw/ there, so one created here would be silently unused — and creating
  // it normalizes exactly the layout the walk-up guard exists to reject.
  if (underTasksSegment(targetDir)) {
    console.error(
      `error: refusing to create a .mrw/ under a 'tasks/' path (${targetDir}) — config there is worker-writable and is ignored by design.`
    );
    process.exit(1);
  }

  if (fs.existsSync(mrwDir)) {
    console.error(
      `error: ${mrwDir} already exists — refusing to overwrite an existing per-workspace config.`
    );
    process.exit(1);
  }

  const srcConfigDir = path.join(toolHome, "config");
  fs.mkdirSync(mrwDir, { recursive: true });

  for (const file of ["workspace.json", "repos.json", "broker-policy.json", "serve.json"]) {
    const src = path.join(srcConfigDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(mrwDir, file));
    } else {
      console.error(`warning: ${src} not found in toolHome config — skipping`);
    }
  }

  const srcPurposesDir = path.join(srcConfigDir, "purposes");
  if (fs.existsSync(srcPurposesDir)) {
    copyDirFlat(srcPurposesDir, path.join(mrwDir, "purposes"));
  }

  // serve.css is an OPTIONAL, per-workspace cosmetic override (see
  // docs/browser-approval.md) — unlike the files above it does not ship by
  // default, so its absence is not warned about.
  const srcServeCss = path.join(srcConfigDir, "serve.css");
  if (fs.existsSync(srcServeCss)) {
    fs.copyFileSync(srcServeCss, path.join(mrwDir, "serve.css"));
  }

  console.log(`Initialized a per-workspace config at ${mrwDir}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Edit ${path.join(mrwDir, "repos.json")} — point it at your own repositories.`);
  console.log(
    `  2. Edit ${path.join(mrwDir, "workspace.json")} — set allowed_push_orgs (and any other fields) for this workspace.`
  );
  console.log(
    `  3. Keep ${path.join(mrwDir, "broker-policy.json")} in sync with the same allowed_push_orgs/allowed_push_hosts (it is the authoritative gate on the container push path).`
  );
  console.log(`  4. cd ${targetDir} && mrw setup   # or: MRW_CONFIG_DIR=${mrwDir} mrw setup`);
}

// ---------------------------------------------------------------------------
// mrw serve — Thread B browser approval (docs/browser-approval.md). Unlike
// every other subcommand above, this does NOT go through runScript/
// runCommand's exec-and-exit pattern for `up`/`url`: it needs to inspect
// docker's output (to read back a port/token, or to warn without failing)
// before deciding what to print, so it calls docker directly via spawnSync
// and manages its own exit codes. `down`/`status` are simple enough to
// reuse runCommand (matching `infra-down`'s style).
const COMPOSE_FILE = path.join(".devcontainer", "docker-compose.yml");
const SERVE_CONTAINER_PORT = 7787;

// resolveServePort — serve.json's "port" (if present and a valid positive
// integer) is the default; an explicit --port always wins. Any parse error
// in serve.json is a WARN-and-fall-back, matching serve's own "never refuse
// to start over cosmetic config" posture (see config/serve.json's $note) —
// this is only the port `mrw serve up` publishes on the host, not something
// worth hard-failing over.
function resolveServePort(portFlag) {
  let port = SERVE_CONTAINER_PORT;
  const serveJsonPath = path.join(configDir, "serve.json");
  if (fs.existsSync(serveJsonPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(serveJsonPath, "utf8"));
      if (typeof cfg.port === "number" && Number.isInteger(cfg.port) && cfg.port > 0) {
        port = cfg.port;
      }
    } catch (err) {
      console.error(`warning: could not parse ${serveJsonPath} (${err.message}) — using default port ${port}`);
    }
  }
  if (portFlag !== null) {
    const n = Number(portFlag);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`error: --port must be a positive integer (got '${portFlag}')`);
      process.exit(1);
    }
    port = n;
  }
  return port;
}

function cmdServeUp(argv) {
  let portFlag = null;
  let noOpen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      if (i + 1 >= argv.length) {
        console.error("error: --port requires a value");
        process.exit(1);
      }
      portFlag = argv[++i];
      continue;
    }
    if (a === "--no-open") {
      noOpen = true;
      continue;
    }
    console.error(`error: mrw serve up: unrecognized argument '${a}'`);
    process.exit(2);
  }

  const port = resolveServePort(portFlag);
  const token = crypto.randomBytes(32).toString("hex");

  // Mirrors scripts/devcontainer-up.sh's OWN conditional MRW_CONFIG_DIR
  // export (not runScript's/runCommand's always-set behavior above): this
  // spawns `docker compose` directly, so it must reproduce exactly what
  // that script does for the compose file's `${MRW_CONFIG_DIR:-../config}`
  // interpolation to resolve identically — legacy mode omits the var
  // entirely so the compose default takes over, byte-identical to before
  // Thread B existed.
  const env = {
    ...process.env,
    MRW_SERVE_TOKEN: token,
    MRW_SERVE_PORT: String(port),
    COMPOSE_PROJECT_NAME: composeProjectName(),
  };
  if (configMode === "workspace") {
    env.MRW_CONFIG_DIR = configDir;
  }

  const upResult = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "--profile", "serve", "up", "-d", "--no-deps", "serve"],
    { stdio: "inherit", cwd: toolHome, env }
  );
  if (upResult.error) {
    console.error(`error: failed to run docker compose: ${upResult.error.message}`);
    process.exit(1);
  }
  if (upResult.status !== 0) {
    process.exit(upResult.status === null ? 1 : upResult.status);
  }

  // Warn (never fail) if the broker container isn't up yet — the approval
  // page will render a clear "broker unreachable" state (see
  // docs/browser-approval.md) until `mrw infra-up` starts it. --no-deps
  // above means this command never starts the broker itself.
  const brokerCheck = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "ps", "--status", "running", "-q", "broker"],
    { cwd: toolHome, env, encoding: "utf8" }
  );
  if (!brokerCheck.error && brokerCheck.status === 0 && !(brokerCheck.stdout || "").trim()) {
    console.error(
      "warning: the broker container is not running yet — the approval page will show " +
        "\"broker unreachable\" until you run 'mrw infra-up'."
    );
  }

  const url = `http://localhost:${port}/?token=${token}`;
  console.log(url);

  if (process.platform === "darwin" && !noOpen) {
    // Best-effort: a failure to open a browser tab is never a reason to
    // fail this command — the URL is already printed above.
    spawnSync("open", [url]);
  }
}

function cmdServeDown(argv) {
  if (argv.length > 0) {
    console.error(`error: mrw serve down: unrecognized argument '${argv[0]}'`);
    process.exit(2);
  }
  runCommand("docker", ["compose", "-f", COMPOSE_FILE, "--profile", "serve", "rm", "-sf", "serve"]);
}

function cmdServeStatus(argv) {
  if (argv.length > 0) {
    console.error(`error: mrw serve status: unrecognized argument '${argv[0]}'`);
    process.exit(2);
  }
  runCommand("docker", ["compose", "-f", COMPOSE_FILE, "ps", "serve"]);
}

function cmdServeUrl(argv) {
  if (argv.length > 0) {
    console.error(`error: mrw serve url: unrecognized argument '${argv[0]}'`);
    process.exit(2);
  }

  const idResult = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "ps", "-q", "serve"], {
    cwd: toolHome,
    env: { ...process.env, COMPOSE_PROJECT_NAME: composeProjectName() },
    encoding: "utf8",
  });
  const containerId = (idResult.stdout || "").trim().split("\n")[0];
  if (idResult.error || !containerId) {
    console.error("error: 'serve' is not running — run 'mrw serve up' first.");
    process.exit(1);
  }

  const envResult = spawnSync("docker", ["inspect", "--format", "{{json .Config.Env}}", containerId], {
    encoding: "utf8",
  });
  if (envResult.error || envResult.status !== 0) {
    console.error(`error: 'docker inspect' failed for the 'serve' container (${containerId}).`);
    process.exit(1);
  }
  let containerEnv;
  try {
    containerEnv = JSON.parse(envResult.stdout);
  } catch (err) {
    console.error(`error: could not parse 'docker inspect' output: ${err.message}`);
    process.exit(1);
  }
  const tokenEntry = Array.isArray(containerEnv)
    ? containerEnv.find((e) => e.startsWith("SERVE_SESSION_TOKEN="))
    : null;
  const token = tokenEntry ? tokenEntry.slice("SERVE_SESSION_TOKEN=".length) : "";
  if (!token) {
    console.error("error: could not read SERVE_SESSION_TOKEN from the running 'serve' container.");
    process.exit(1);
  }

  const portResult = spawnSync("docker", ["port", containerId, `${SERVE_CONTAINER_PORT}/tcp`], {
    encoding: "utf8",
  });
  const portLine = (portResult.stdout || "").trim().split("\n")[0];
  const portMatch = portLine ? /:(\d+)$/.exec(portLine) : null;
  const port = portMatch ? portMatch[1] : String(SERVE_CONTAINER_PORT);

  console.log(`http://localhost:${port}/?token=${token}`);
}

function cmdServe(argv) {
  let action = "up";
  let rest = argv;
  if (argv.length > 0 && !argv[0].startsWith("-")) {
    action = argv[0];
    rest = argv.slice(1);
  }
  switch (action) {
    case "up":
      cmdServeUp(rest);
      break;
    case "down":
      cmdServeDown(rest);
      break;
    case "url":
      cmdServeUrl(rest);
      break;
    case "status":
      cmdServeStatus(rest);
      break;
    default:
      console.error(`error: mrw serve: unknown action '${action}' (expected up|down|url|status)`);
      process.exit(2);
  }
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

    case "init":
      cmdInit(rest);
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

    case "chat":
      runScript("chat-up.sh", rest);
      break;

    case "serve":
      cmdServe(rest);
      break;

    default:
      console.error(`error: unknown subcommand '${sub}'\n`);
      printUsage();
      process.exit(2);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();
