/**
 * config.ts — serve's env contract (§3.1) and the SERVE_CONFIG_DIR/serve.json
 * loader (§3.5).
 *
 * Two very different trust postures live in this one file, mirroring
 * broker/src/config.ts's split between env (operator-controlled, read once
 * at boot) and policy (a broker-owned file, also operator-controlled but
 * loaded per-request there). Here:
 *  - env (`loadEnv`) is FAIL-CLOSED: a missing/short session token or an
 *    unset approval socket path means serve refuses to start at all (see
 *    index.ts, which is the only caller and the only place allowed to
 *    process.exit()).
 *  - serve.json (`loadServeConfig`) is the OPPOSITE posture, deliberately:
 *    it is cosmetic/UX configuration, not a security boundary (the
 *    security boundary is the env contract above, plus security.ts's
 *    middleware, neither of which serve.json can touch), so §3.5 requires
 *    it NEVER fail the process — every bad shape degrades to a built-in
 *    default, logged, at the smallest granularity possible.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// --- §3.1 env contract -------------------------------------------------

export interface ServeEnv {
  approvalSocket: string;
  sessionToken: string;
  port: number;
  bind: string;
  configDir: string | null;
}

const MIN_TOKEN_LENGTH = 32;
const DEFAULT_PORT = 7787;
const DEFAULT_BIND = "127.0.0.1";

/**
 * Fail-closed: throws on anything that would otherwise start an
 * unauthenticated or disconnected server. Callers (index.ts) must treat a
 * throw as "log and process.exit(1)", never as "start anyway".
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): ServeEnv {
  const approvalSocket = (env.SERVE_APPROVAL_SOCKET ?? "").trim();
  if (!approvalSocket) {
    throw new Error(
      "SERVE_APPROVAL_SOCKET is not set (fail-closed) — serve has no broker approval socket to connect to.",
    );
  }

  const sessionToken = env.SERVE_SESSION_TOKEN ?? "";
  if (sessionToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `SERVE_SESSION_TOKEN is unset or shorter than ${MIN_TOKEN_LENGTH} chars (fail-closed) — ` +
        "serve refuses to start unauthenticated.",
    );
  }

  let port = DEFAULT_PORT;
  if (env.SERVE_PORT !== undefined && env.SERVE_PORT.trim() !== "") {
    const n = Number(env.SERVE_PORT);
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      port = n;
    } else {
      console.warn(`[serve] SERVE_PORT='${env.SERVE_PORT}' is invalid — using default ${DEFAULT_PORT}`);
    }
  }

  const bind = env.SERVE_BIND && env.SERVE_BIND.trim() ? env.SERVE_BIND.trim() : DEFAULT_BIND;
  const configDir = env.SERVE_CONFIG_DIR && env.SERVE_CONFIG_DIR.trim() ? env.SERVE_CONFIG_DIR.trim() : null;

  return { approvalSocket, sessionToken, port, bind, configDir };
}

// --- §3.5 serve.json / serve.css --------------------------------------

const ThemeSchema = z.enum(["auto", "light", "dark"]);
const DiffViewSchema = z.enum(["unified", "split"]);

export interface DiffConfig {
  view: "unified" | "split";
  wrap: boolean;
  tabSize: number;
  collapseThresholdLines: number;
  intralineHighlight: boolean;
}

export interface SectionsConfig {
  body: boolean;
  commits: boolean;
  reviewer: boolean;
  fileTree: boolean;
}

export interface ServeConfig {
  theme: "auto" | "light" | "dark";
  title: string;
  accentColor: string;
  pollIntervalMs: number;
  diff: DiffConfig;
  sections: SectionsConfig;
  customCss: boolean;
}

export const DEFAULT_SERVE_CONFIG: ServeConfig = {
  theme: "auto",
  title: "mrw approval",
  accentColor: "#0969da",
  pollIntervalMs: 2000,
  diff: { view: "unified", wrap: false, tabSize: 8, collapseThresholdLines: 400, intralineHighlight: true },
  sections: { body: true, commits: true, reviewer: true, fileTree: true },
  customCss: true,
};

// `port` is a legal serve.json key — the `mrw serve` CLI (cli/mrw.mjs, Agent
// W's side of this feature) reads it to pick the published port. serve
// itself ignores it (SERVE_PORT is authoritative for what this PROCESS
// actually binds — see loadEnv above); accepting-but-ignoring it here keeps
// one shared serve.json usable by both without tripping the unknown-key
// warning below.
const KNOWN_TOP_KEYS = ["port", "theme", "title", "accentColor", "pollIntervalMs", "diff", "sections", "customCss"];
const KNOWN_DIFF_KEYS = ["view", "wrap", "tabSize", "collapseThresholdLines", "intralineHighlight"];
const KNOWN_SECTIONS_KEYS = ["body", "commits", "reviewer", "fileTree"];

type Warn = (msg: string) => void;

/** One field, one independent fallback: an invalid value for `key` warns and
 *  falls back to `def` WITHOUT affecting any sibling field. */
function field<T>(
  raw: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
  def: T,
  warn: Warn,
  pathPrefix = "",
): T {
  if (!(key in raw)) return def;
  const parsed = schema.safeParse(raw[key]);
  if (parsed.success) return parsed.data;
  const reason = parsed.error.issues[0]?.message ?? "validation failed";
  warn(`serve.json: '${pathPrefix}${key}' is invalid (${reason}) — using default ${JSON.stringify(def)}`);
  return def;
}

function warnUnknownKeys(raw: Record<string, unknown>, known: string[], where: string, warn: Warn): void {
  // Keys starting with "_" or "$" are the repo's in-JSON documentation
  // convention (config/workspace.json's `_note`, config/serve.json's
  // `$note`/`*_note`) — the SHIPPED default file uses them, so warning on
  // them would make every boot noisy. Anything else unknown still warns.
  const extra = Object.keys(raw).filter(
    (k) => !known.includes(k) && !k.startsWith("_") && !k.startsWith("$") && !k.endsWith("_note"),
  );
  if (extra.length) warn(`serve.json: ignoring unknown key(s) in ${where}: ${extra.join(", ")}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseDiffConfig(raw: unknown, warn: Warn): DiffConfig {
  const def = DEFAULT_SERVE_CONFIG.diff;
  if (raw === undefined) return def;
  if (!isPlainObject(raw)) {
    warn("serve.json: 'diff' is not an object — using defaults for the whole section");
    return def;
  }
  warnUnknownKeys(raw, KNOWN_DIFF_KEYS, "diff", warn);
  return {
    view: field(raw, "view", DiffViewSchema, def.view, warn, "diff."),
    wrap: field(raw, "wrap", z.boolean(), def.wrap, warn, "diff."),
    tabSize: field(raw, "tabSize", z.number().int().min(1).max(16), def.tabSize, warn, "diff."),
    collapseThresholdLines: field(
      raw,
      "collapseThresholdLines",
      z.number().int().positive(),
      def.collapseThresholdLines,
      warn,
      "diff.",
    ),
    intralineHighlight: field(raw, "intralineHighlight", z.boolean(), def.intralineHighlight, warn, "diff."),
  };
}

function parseSectionsConfig(raw: unknown, warn: Warn): SectionsConfig {
  const def = DEFAULT_SERVE_CONFIG.sections;
  if (raw === undefined) return def;
  if (!isPlainObject(raw)) {
    warn("serve.json: 'sections' is not an object — using defaults for the whole section");
    return def;
  }
  warnUnknownKeys(raw, KNOWN_SECTIONS_KEYS, "sections", warn);
  return {
    body: field(raw, "body", z.boolean(), def.body, warn, "sections."),
    commits: field(raw, "commits", z.boolean(), def.commits, warn, "sections."),
    reviewer: field(raw, "reviewer", z.boolean(), def.reviewer, warn, "sections."),
    fileTree: field(raw, "fileTree", z.boolean(), def.fileTree, warn, "sections."),
  };
}

/**
 * Load SERVE_CONFIG_DIR/serve.json. NEVER throws: no file, an unreadable
 * file, invalid JSON, a non-object top level, or any individual bad/unknown
 * field all degrade to (partial) defaults rather than refusing to start.
 */
export function loadServeConfig(
  configDir: string | null,
  warn: Warn = (m) => console.warn(`[serve] ${m}`),
): ServeConfig {
  if (!configDir) return DEFAULT_SERVE_CONFIG;
  const file = path.join(configDir, "serve.json");

  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return DEFAULT_SERVE_CONFIG;
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    warn(`could not read/parse ${file} — using built-in defaults: ${(e as Error).message}`);
    return DEFAULT_SERVE_CONFIG;
  }
  if (!isPlainObject(raw)) {
    warn(`${file} is not a JSON object — using built-in defaults`);
    return DEFAULT_SERVE_CONFIG;
  }
  warnUnknownKeys(raw, KNOWN_TOP_KEYS, "serve.json", warn);

  return {
    theme: field(raw, "theme", ThemeSchema, DEFAULT_SERVE_CONFIG.theme, warn),
    title: field(raw, "title", z.string().min(1).max(200), DEFAULT_SERVE_CONFIG.title, warn),
    accentColor: field(
      raw,
      "accentColor",
      z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
      DEFAULT_SERVE_CONFIG.accentColor,
      warn,
    ),
    pollIntervalMs: field(
      raw,
      "pollIntervalMs",
      z.number().int().min(250).max(60_000),
      DEFAULT_SERVE_CONFIG.pollIntervalMs,
      warn,
    ),
    diff: parseDiffConfig(raw.diff, warn),
    sections: parseSectionsConfig(raw.sections, warn),
    customCss: field(raw, "customCss", z.boolean(), DEFAULT_SERVE_CONFIG.customCss, warn),
  };
}

/** Path to serve.css if (and only if) it exists — routes.ts uses this to
 *  decide both whether GET /assets/custom.css is servable and whether the
 *  SSR shell should link it at all (§3.3: "the latter only when config
 *  enables it AND SERVE_CONFIG_DIR/serve.css exists"). */
export function customCssPath(configDir: string | null): string | null {
  if (!configDir) return null;
  const p = path.join(configDir, "serve.css");
  return fs.existsSync(p) ? p : null;
}
