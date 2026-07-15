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
// output (and TTY prompts) pass straight through.
function runScript(relativeScriptPath, argv) {
  const scriptPath = path.join(toolHome, "scripts", relativeScriptPath);
  const result = spawnSync(scriptPath, argv, { stdio: "inherit", cwd: toolHome });
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
// URL positional with no ID (link-based triage is a later slice).
function buildTaskUpArgs(argv) {
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
      forwarded.push("--ticket-url", argv[++i]);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) {
        console.error(`error: ${a} requires a value`);
        process.exit(1);
      }
      forwarded.push(a, argv[++i]);
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
          `error: pass --ticket <ID> for now; link-based triage lands in a later slice (got a link: ${first})`
        );
        process.exit(1);
      }
      ticketId = first;
      forwarded.push(...positionals.slice(1));
    }
  } else {
    forwarded.push(...positionals);
  }

  if (ticketId === null) {
    console.error("error: mrw task-up requires --ticket <ID> (or a positional ticket ID)");
    process.exit(1);
  }

  return ["--phase", "all", "--ticket", ticketId, ...forwarded];
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

    case "task-up": {
      const forwardedArgs = buildTaskUpArgs(rest);
      runScript("create-workspace.sh", forwardedArgs);
      break;
    }

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
