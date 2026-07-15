/**
 * multi/types.ts — contracts for the Phase 3 multi-repo driver.
 *
 * Two kinds of typed data:
 *   1. The workspace CONFIG the driver reads (config/repos.json,
 *      config/workspace.json) — validated so a malformed config fails loudly,
 *      never silently mis-targets a repo.
 *   2. The per-ticket STATE the driver persists (tasks/<ticket>/phase3-state.json)
 *      for resumability — validated on load so a corrupt file is ignored rather
 *      than trusted.
 */
import { z } from "zod";

// --- config/repos.json -------------------------------------------------------
// A single repository entry. `type` is 'knowledge' for sparse-checkout repos and
// anything else ('code' / 'app') for a full checkout. `sparse_paths` maps a
// purpose ('dev' | 'task' | …) to the cone paths to check out for knowledge repos.
export const RepoConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  desc: z.string().optional(),
  type: z.string().optional(),
  sparse_paths: z.record(z.string(), z.array(z.string())).optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const ReposFileSchema = z.object({
  repositories: z.array(RepoConfigSchema).min(1),
});
export type ReposFile = z.infer<typeof ReposFileSchema>;

// --- config/workspace.json (only the fields the driver uses) -----------------
export const WorkspaceConfigSchema = z.object({
  branch_prefix: z.string().default("feat/"),
  default_purpose: z.string().default("dev"),
  ticket_id_pattern: z.string().optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// --- tasks/<ticket>/phase3-state.json (resumability) -------------------------
// 'pending' is a repo that has a worktree but no terminal outcome yet. A re-run
// SKIPS only repos whose outcome is 'published'; every other state re-runs.
export const RepoStateSchema = z.object({
  outcome: z.enum(["published", "declined", "not_ready", "failed", "pending"]),
  sha: z.string().optional(),
  prUrl: z.string().nullable().optional(),
  reason: z.string().optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type RepoState = z.infer<typeof RepoStateSchema>;

export const TicketStateSchema = z.object({
  ticket: z.string(),
  instruction: z.string(),
  branch: z.string(),
  purpose: z.string(),
  repos: z.record(z.string(), RepoStateSchema),
  updatedAt: z.string(),
});
export type TicketState = z.infer<typeof TicketStateSchema>;

// --- driver invocation -------------------------------------------------------
export interface DriverArgs {
  ticket: string;
  instruction: string;
  /** Subset of repo names to run (in this order). Empty ⇒ all repos in config. */
  repos: string[];
  /** Override for sparse-checkout purpose. Empty ⇒ workspace default_purpose. */
  purpose: string;
}
