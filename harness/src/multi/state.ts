/**
 * multi/state.ts — per-ticket progress, persisted for RESUMABILITY.
 *
 * The ticket state file (tasks/<ticket>/phase3-state.json) records each repo's
 * terminal outcome. Publishing is the CHECKPOINT: a repo marked 'published' is
 * SKIPPED on a re-run, so a mid-sequence failure can be re-run and it resumes at
 * the first not-yet-published repo. Writes are atomic (temp file + rename) so a
 * crash mid-write never corrupts the record. A corrupt file on load is ignored
 * (not trusted) — the driver simply re-plans from scratch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TicketStateSchema, type RepoState, type TicketState } from "./types.js";

export function stateDir(root: string, ticket: string): string {
  return path.join(root, "tasks", ticket);
}

export function statePath(root: string, ticket: string): string {
  return path.join(stateDir(root, ticket), "phase3-state.json");
}

/** Load and validate the ticket state, or null if absent/corrupt. */
export function loadState(root: string, ticket: string): TicketState | null {
  const file = statePath(root, ticket);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const parsed = TicketStateSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[state] ${file} is invalid (${parsed.error.message}) — ignoring it.`);
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn(`[state] could not read ${file} (${(err as Error).message}) — ignoring it.`);
    return null;
  }
}

/** Atomically persist the ticket state (stamps updatedAt). */
export function saveState(root: string, ticket: string, state: TicketState): void {
  fs.mkdirSync(stateDir(root, ticket), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const file = statePath(root, ticket);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Record one repo's state and persist immediately (the resumability checkpoint). */
export function setRepoState(
  root: string,
  ticket: string,
  state: TicketState,
  repo: string,
  patch: RepoState,
): void {
  state.repos[repo] = { ...patch, updatedAt: new Date().toISOString() };
  saveState(root, ticket, state);
}
