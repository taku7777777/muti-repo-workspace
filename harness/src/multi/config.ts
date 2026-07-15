/**
 * multi/config.ts — locate the workspace and load its typed config.
 *
 * The driver runs INSIDE the caged coder container, at <ws>/harness. The
 * workspace root is resolved from this module's location (…/harness/src/multi →
 * up three) or overridden with MRW_WORKSPACE_ROOT. Both config files are read
 * once, up front, and validated — a malformed config is a hard, loud failure.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReposFileSchema,
  WorkspaceConfigSchema,
  type RepoConfig,
  type WorkspaceConfig,
} from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <ws>/harness/src/multi

/** Absolute workspace root (contains config/, repositories/, tasks/). */
export function resolveWorkspaceRoot(): string {
  const override = process.env.MRW_WORKSPACE_ROOT;
  if (override) return path.resolve(override);
  return path.resolve(HERE, "..", "..", "..");
}

function readJson(file: string): unknown {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as unknown;
}

/** Load and validate config/repos.json. */
export function loadRepos(root: string): RepoConfig[] {
  const file = path.join(root, "config", "repos.json");
  const parsed = ReposFileSchema.safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(`config/repos.json is invalid: ${parsed.error.message}`);
  }
  return parsed.data.repositories;
}

/** Load and validate config/workspace.json (defaults applied). */
export function loadWorkspace(root: string): WorkspaceConfig {
  const file = path.join(root, "config", "workspace.json");
  const parsed = WorkspaceConfigSchema.safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(`config/workspace.json is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Resolve the requested repos to config entries, in a deterministic order:
 * the order of `subset` when given, else config file order. Unknown names are a
 * hard error listing what is available (never silently drop a repo).
 */
export function selectRepos(all: RepoConfig[], subset: string[]): RepoConfig[] {
  if (subset.length === 0) return all;
  const byName = new Map(all.map((r) => [r.name, r]));
  const unknown = subset.filter((n) => !byName.has(n));
  if (unknown.length) {
    throw new Error(
      `unknown repo(s) in --repos: ${unknown.join(", ")}. ` +
        `Available: ${all.map((r) => r.name).join(", ")}`,
    );
  }
  return subset.map((n) => byName.get(n)!);
}
