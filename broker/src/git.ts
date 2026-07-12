/**
 * git.ts — trusted-side git/gh wrappers. Two strictly separated worlds:
 *
 *   READ-SIDE, run in the coder's worktree (untrusted tree). ONLY to learn a few
 *   ground facts (branch, HEAD sha, cleanliness, the raw origin string, the object
 *   dir). Every such command runs with git config isolation (F1): global & system
 *   config nulled, no token in env, `-c core.fsmonitor=false`, prompts disabled,
 *   pager neutralized; diffs additionally `--no-ext-diff --no-textconv`. A prior
 *   scan (scanUntrustedLocalConfig) fail-closes on any exec-/redirect-capable
 *   LOCAL config key so no coder config is ever executed.
 *
 *   NETWORK-SIDE (fetch/push) and GROUND-TRUTH rendering, run in a BROKER-PRIVATE
 *   scratch bare repo whose config we control. The coder's committed objects are
 *   reached by sha via GIT_ALTERNATE_OBJECT_DIRECTORIES — so the coder's LOCAL
 *   .git config (insteadOf, http.proxy, credential.helper, hooks, fsmonitor, …) is
 *   NEVER consulted for any authenticated or network operation, and the token can
 *   never be redirected or captured by it. The push target is a broker-CONSTRUCTED,
 *   allowlist-validated URL and the pushed object is the EXACT approved sha (F4).
 *
 * All commands use argv arrays and spawnSync — never a shell string.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean; // maxBuffer overflow => never trust a truncated render
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** git config isolation shared by every git/gh invocation (F1). Global & system
 *  config are nulled; the GitHub token is STRIPPED (read-side must never see it).
 *  netEnv() re-adds the token and object alternates for the scratch-repo ops. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.GH_TOKEN;
  delete e.GITHUB_TOKEN;
  delete e.BROKER_GITHUB_TOKEN;
  delete e.MRW_BROKER_GH_TOKEN;
  delete e.GIT_ASKPASS;
  delete e.SSH_ASKPASS;
  delete e.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  e.GIT_CONFIG_GLOBAL = "/dev/null";
  e.GIT_CONFIG_SYSTEM = "/dev/null";
  e.GIT_CONFIG_NOSYSTEM = "1";
  e.GIT_ATTR_NOSYSTEM = "1";
  e.GIT_TERMINAL_PROMPT = "0";
  e.GIT_PAGER = "cat";
  e.PAGER = "cat";
  return e;
}

/** Read-side env: isolated, NO token. */
function readEnv(): NodeJS.ProcessEnv {
  return isolatedEnv();
}

/** Network-side env: isolated + the token (for fetch/push/gh) + optional object
 *  alternates so the scratch repo can read the coder's objects by sha. */
function netEnv(token: string | undefined, alternates?: string): NodeJS.ProcessEnv {
  const e = isolatedEnv();
  if (token) {
    e.GH_TOKEN = token;
    e.GITHUB_TOKEN = token;
    e.MRW_BROKER_GH_TOKEN = token;
  }
  if (alternates) e.GIT_ALTERNATE_OBJECT_DIRECTORIES = alternates;
  return e;
}

// Forced on every git we run. `-c core.fsmonitor=false` overrides any coder
// fsmonitor (a program git would otherwise EXECUTE) since command-line -c wins.
const FLAGS = ["-c", "core.fsmonitor=false"];

/** Inline credential-helper args for the BROKER-PRIVATE network ops (ls-remote /
 *  fetch / push). The helper reads $MRW_BROKER_GH_TOKEN (supplied via netEnv);
 *  the leading empty `credential.helper=`/`core.askpass=` reset the lists so
 *  nothing coder-controlled can be invoked. Used for AUTHENTICATED commands only
 *  — the token never touches read-side worktree commands. */
function credArgs(token: string | undefined): string[] {
  if (!token) return [];
  const helper =
    "!f() { test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$MRW_BROKER_GH_TOKEN\"; }; f";
  return ["-c", "credential.helper=", "-c", "core.askpass=", "-c", `credential.helper=${helper}`];
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): RunResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, env, cwd });
  const truncated = !!(r.error && (r.error as NodeJS.ErrnoException).code === "ENOBUFS");
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// READ-SIDE — in the coder's worktree, config-isolated, no token.
// ---------------------------------------------------------------------------

function gitRead(wt: string, args: string[]): RunResult {
  return run("git", ["-C", wt, ...FLAGS, ...args], readEnv());
}

/** Exec-/redirect-capable LOCAL config keys. Their presence means the coder's
 *  .git could execute code or redirect the push/token, so we FAIL CLOSED rather
 *  than run any further git in that repo. (Global & system are already nulled, so
 *  --list under isolation surfaces only LOCAL keys, including any pulled via
 *  include.path — which is itself in the denylist.) */
const DANGEROUS_CONFIG =
  /^(filter\.[^.]*\.(clean|smudge|process)|core\.(fsmonitor|hookspath|sshcommand|askpass|pager|editor|fsmonitorhookversion)|url\..*\.(insteadof|pushinsteadof)|http\..*|credential\..*|diff\.[^.]*\.(command|textconv)|gpg\..*|ssh\.variant|protocol\..*|uploadpack\..*|receivepack\..*|init\.templatedir|include\.path|includeif\..*)$/i;

/** Returns the first dangerous LOCAL config key, or null when the repo config is
 *  inert. A hard failure to read config is itself fail-closed (returns a message). */
export function scanUntrustedLocalConfig(wt: string): string | null {
  const r = run("git", ["-C", wt, ...FLAGS, "config", "--local", "--list", "--name-only", "-z"], readEnv());
  if (!r.ok) {
    return `cannot read local git config for '${wt}' (fail-closed): ${(r.stderr || "unknown").trim()}`;
  }
  for (const k of r.stdout.split("\0").map((s) => s.trim()).filter(Boolean)) {
    if (DANGEROUS_CONFIG.test(k)) return k;
  }
  return null;
}

export function currentBranch(wt: string): string | null {
  const r = gitRead(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

export function headSha(wt: string): string | null {
  const r = gitRead(wt, ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

/** Non-empty porcelain => uncommitted OR untracked changes (matches
 *  push-create-pr.sh's clean gate). Safe to run because scanUntrustedLocalConfig
 *  has already fail-closed on any filter/fsmonitor that status could execute. */
export function isDirty(wt: string): boolean | null {
  const r = gitRead(wt, ["status", "--porcelain"]);
  if (!r.ok) return null;
  return r.stdout.trim().length > 0;
}

export function remoteUrl(wt: string, remote = "origin"): string | null {
  const r = gitRead(wt, ["remote", "get-url", remote]);
  if (!r.ok) return null;
  const url = r.stdout.trim();
  return url.length ? url : null;
}

/** Absolute path to the coder repo's object store — content-addressed, so trusting
 *  it is trusting objects BY SHA, not any coder config. */
export function coderObjectsDir(wt: string): string | null {
  const r = gitRead(wt, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return null;
  let g = r.stdout.trim();
  if (!g) return null;
  if (!path.isAbsolute(g)) g = path.resolve(wt, g);
  const obj = path.join(g, "objects");
  return fs.existsSync(obj) ? obj : null;
}

// ---------------------------------------------------------------------------
// Origin parsing → canonical push URL (F4).
// ---------------------------------------------------------------------------

export interface Remote {
  host: string;
  org: string;
  repo: string;
}

/** Parse host/org/repo from an origin URL. The raw string is UNTRUSTED — we only
 *  extract components; the canonical URL we actually push to is REBUILT from the
 *  validated pieces (never the raw string), which defeats embedded creds, extra
 *  path segments, and insteadOf-shaped inputs. */
export function parseRemote(url: string): Remote | null {
  let m = url.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (m) return { host: m[1], org: m[2], repo: m[3] };
  m = url.match(/^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return { host: m[1], org: m[2], repo: m[3] };
  return null;
}

const HOST_RE = /^[A-Za-z0-9.-]+$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Rebuild an explicit https URL from validated components, or null if any
 *  component is malformed. */
export function canonicalHttpsUrl(r: Remote): string | null {
  if (!HOST_RE.test(r.host) || r.host.includes("..")) return null;
  if (!NAME_RE.test(r.org) || r.org === "." || r.org.includes("..")) return null;
  if (!NAME_RE.test(r.repo) || r.repo === "." || r.repo.includes("..")) return null;
  return `https://${r.host}/${r.org}/${r.repo}.git`;
}

// ---------------------------------------------------------------------------
// BROKER-PRIVATE scratch repo — network ops + ground truth, isolated from ALL
// coder config (global, system AND local) via a clean bare repo + alternates.
// ---------------------------------------------------------------------------

/** Create a throwaway bare repo whose config the broker fully controls. */
export function createScratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrw-broker-"));
  // `-c` are top-level git options and MUST precede the `init` subcommand. Empty
  // init.templateDir prevents any template hooks from being installed.
  const r = run("git", ["-c", "init.templateDir=", ...FLAGS, "init", "--bare", "-q", dir], readEnv());
  if (!r.ok) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`cannot init scratch repo (fail-closed): ${(r.stderr || "unknown").trim()}`);
  }
  return dir;
}

export function removeScratch(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface RenderParams {
  scratch: string;
  objectsDir: string;
  sha: string;
  url: string;
  branch: string;
  token: string | undefined;
}

export type Render =
  | {
      ok: true;
      remoteTip: string | null; // freshly-fetched remote branch tip; null = brand-new branch
      unpushed: number; // commit count base..sha
      commitList: string;
      diffStat: string;
      diff: string;
    }
  | { ok: false; code: "fetch_failed" | "render_incomplete"; error: string };

/**
 * Render GROUND TRUTH (F3): FIRST fetch the branch from the constructed,
 * validated URL into a broker-private ref, then compute the unpushed set and the
 * diff base against that FRESHLY-FETCHED ref (empty tree for a brand-new branch) —
 * NEVER against local refs/remotes/*. Every git call is asserted complete
 * (ok && !truncated); a git error or maxBuffer overflow is a HARD fail-closed, so
 * the human is never shown a truncated or empty "ground truth".
 */
export function renderGroundTruth(p: RenderParams): Render {
  const env = netEnv(p.token, p.objectsDir);
  const R = (args: string[]): RunResult => run("git", ["-C", p.scratch, ...FLAGS, ...args], env);
  // Authenticated variant: same isolation + the inline credential helper, so
  // ls-remote/fetch work against a PRIVATE remote (the read-only local log/diff
  // below need no creds — they resolve objects by sha via the alternates).
  const RN = (args: string[]): RunResult =>
    run("git", ["-C", p.scratch, ...FLAGS, ...credArgs(p.token), ...args], env);

  // 1. Connectivity + does the branch already exist on the remote?
  const lsr = RN(["ls-remote", "--heads", p.url, `refs/heads/${p.branch}`]);
  if (!lsr.ok || lsr.truncated) {
    return { ok: false, code: "fetch_failed", error: `ls-remote failed: ${(lsr.stderr || lsr.stdout || "unknown").trim()}` };
  }

  let remoteTip: string | null = null;
  const line = lsr.stdout.trim();
  if (line) {
    const tip = line.split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{7,64}$/i.test(tip)) {
      return { ok: false, code: "fetch_failed", error: `cannot parse remote tip from '${line}'` };
    }
    const f = RN(["fetch", "--no-tags", "--quiet", p.url, `+refs/heads/${p.branch}:refs/broker/base`]);
    if (!f.ok || f.truncated) {
      return { ok: false, code: "fetch_failed", error: `fetch failed: ${(f.stderr || f.stdout || "unknown").trim()}` };
    }
    const rp = R(["rev-parse", "--verify", "--quiet", "refs/broker/base"]);
    if (!rp.ok || !rp.stdout.trim()) {
      return { ok: false, code: "fetch_failed", error: "fetched base ref missing after fetch" };
    }
    remoteTip = rp.stdout.trim();
  }

  const base = remoteTip ?? EMPTY_TREE;
  const range = remoteTip ? `${remoteTip}..${p.sha}` : p.sha;

  const lg = R(["log", "--no-color", "--oneline", "--no-decorate", range]);
  if (!lg.ok || lg.truncated) {
    return { ok: false, code: "render_incomplete", error: `git log failed: ${(lg.stderr || "truncated").trim()}` };
  }
  const cnt = R(["rev-list", "--count", range]);
  if (!cnt.ok || cnt.truncated) {
    return { ok: false, code: "render_incomplete", error: `git rev-list failed: ${(cnt.stderr || "truncated").trim()}` };
  }
  const st = R(["diff", "--no-color", "--stat", "--no-ext-diff", "--no-textconv", base, p.sha]);
  if (!st.ok || st.truncated) {
    return { ok: false, code: "render_incomplete", error: `git diff --stat failed: ${(st.stderr || "truncated").trim()}` };
  }
  const df = R(["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, p.sha]);
  if (!df.ok || df.truncated) {
    return {
      ok: false,
      code: "render_incomplete",
      error: `git diff failed or oversize (fail-closed): ${(df.stderr || "truncated").trim()}`,
    };
  }

  return {
    ok: true,
    remoteTip,
    unpushed: parseInt(cnt.stdout.trim() || "0", 10),
    commitList: lg.stdout.trim(),
    diffStat: st.stdout.trim(),
    diff: df.stdout.trim(),
  };
}

/**
 * Push the EXACT approved object by sha to the broker-CONSTRUCTED URL (F4), from
 * the scratch repo. No hooks (none exist here), never --no-verify. The token is
 * supplied via an inline credential helper reading $MRW_BROKER_GH_TOKEN; we reset
 * the helper list first so nothing else can be invoked. Because the scratch repo's
 * config is broker-owned and global/system are nulled, no insteadOf/pushInsteadOf/
 * http.proxy/credential.helper the coder wrote can redirect the push or the token.
 */
export function pushApprovedSha(p: RenderParams): RunResult {
  const args = [
    "-C",
    p.scratch,
    ...FLAGS,
    ...credArgs(p.token),
    "push",
    p.url,
    `${p.sha}:refs/heads/${p.branch}`,
  ];
  return run("git", args, netEnv(p.token, p.objectsDir));
}

export interface PrArgs {
  host: string;
  org: string;
  repo: string;
  title: string;
  body: string;
  branch: string;
  base?: string;
  draft?: boolean;
  token: string | undefined;
}

/** `gh pr create` against the EXPLICIT --repo <org>/<repo> (never the coder's
 *  worktree remote). Enterprise hosts are selected via GH_HOST. Title/body/branch
 *  are argv, never a shell string. */
export function ghPrCreate(a: PrArgs): RunResult & { url: string | null } {
  const args = [
    "pr",
    "create",
    "--repo",
    `${a.org}/${a.repo}`,
    "--title",
    a.title,
    "--head",
    a.branch,
    "--body",
    a.body,
  ];
  if (a.base) args.push("--base", a.base);
  if (a.draft) args.push("--draft");

  const env = netEnv(a.token);
  if (a.host && a.host !== "github.com") env.GH_HOST = a.host;

  const r = run("gh", args, env, os.tmpdir());
  const urlMatch = r.stdout.match(/https?:\/\/\S+/);
  return { ...r, url: urlMatch ? urlMatch[0] : null };
}
