/**
 * spined/lock.ts — per-ticket single-instance guard for the spined MCP
 * daemon (docs/mrw-chat.md "New pieces": "Single instance per ticket").
 *
 * WHY: a second spined process dispatching against the SAME on-disk ledger
 * would double the budget rails (two independent in-memory `actionsUsed`
 * counters both under the persisted max) and last-writer-win every
 * persist() — invisibly corrupting the invariant ledger the whole design
 * depends on. A second chat tab on the same ticket (or a chat tab racing the
 * legacy REPL — see the scope note below) must fail closed at startup
 * instead.
 *
 * Mechanism: an exclusive lockfile (`<dir>/spined.lock`) created with
 * O_CREAT|O_EXCL so two processes racing to create it can never both
 * succeed. On EEXIST we read the pid the existing lock recorded and ask the
 * OS whether it is still alive (`process.kill(pid, 0)`):
 *   - alive (or we cannot tell — an unreadable/corrupt lock file)  => FAIL
 *     CLOSED: refuse to guess that a live daemon is actually gone. (Even
 *     "alive" is a probabilistic signal, not a proof: the OS can recycle a
 *     dead pid for an unrelated process — see the error message below.)
 *   - genuinely dead (ESRCH)                                       => the
 *     lock is STALE (its owner crashed/was killed without cleanup) and safe
 *     to take over.
 *
 * TAKEOVER IS ATOMIC (fixes a TOCTOU an independent review caught): two
 * daemons can observe the SAME dead pid and both decide "stale, take over"
 * at the same time. Naively removing the file (`rmSync`) and recreating it
 * is NOT safe — process B's `rmSync` can delete process A's freshly-created
 * fresh lock a moment after A wins its own `tryCreate`, leaving BOTH
 * processes believing they hold the lock while only B's file actually
 * exists on disk. Instead, takeover RENAMES the stale file out of the way
 * first (`fs.renameSync`): a rename's source can only ever be claimed by
 * ONE caller — every other racer's `renameSync` gets ENOENT (the source is
 * already gone) and MUST fail closed right there, never falling through to
 * its own `tryCreate` (which would itself race the winner's). See
 * `takeOverStaleLock()` below.
 *
 * Released on clean exit and on SIGINT/SIGTERM by the caller (spined/index.ts
 * wires `release()` into its own shutdown handlers) — this module never
 * installs process-level signal handlers itself, so it stays trivially
 * testable (acquire/release as plain synchronous calls).
 *
 * SCOPE NOTE: this guards against a second `spined` process for the same
 * ticket — the case THIS phase's daemon actually introduces (e.g. two chat
 * tabs). The legacy REPL (spine/index.ts) predates this lock and is out of
 * this phase's file scope (docs/mrw-chat.md Phase C2 hard constraints); it
 * does not take this lock, so "chat + legacy REPL" mutual exclusion named in
 * the design memo is not yet fully enforced end-to-end — flagged here for a
 * follow-up phase rather than silently implied.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SpinedLock {
  /** Idempotent — safe to call more than once (e.g. from both a signal
   *  handler and a normal shutdown path racing each other). */
  release(): void;
}

interface LockFileContents {
  pid: number;
  startedAt: string;
}

function lockFilePath(dir: string): string {
  return path.join(dir, "spined.lock");
}

/** true = definitely alive, false = definitely dead (ESRCH). A process owned
 *  by another user (EPERM) is treated as ALIVE — we can't signal it, but it
 *  answered, which means it exists; fail closed rather than assume gone. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockPid(file: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockFileContents>;
    return typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null;
  } catch {
    return null; // unreadable/corrupt — caller treats this as "cannot attribute, fail closed"
  }
}

function tryCreate(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new Error(`spined: cannot create lockfile '${file}': ${(e as Error).message}`);
  }
  try {
    const contents: LockFileContents = { pid: process.pid, startedAt: new Date().toISOString() };
    fs.writeSync(fd, JSON.stringify(contents));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Atomically claim a lockfile already judged STALE (dead pid) by renaming it
 * out of the way first. `fs.renameSync`'s source can only ever be claimed by
 * one caller: if we win, `file` no longer exists afterward and the caller
 * may safely `tryCreate(file)` next. If we LOSE — another process's rename
 * won the race a moment earlier — our own `renameSync` throws ENOENT, and
 * this function throws a fail-closed error; the caller must NOT retry
 * `tryCreate()` in that case (see lock.ts's header: that fallback is exactly
 * the TOCTOU this function exists to close). Exported so both interleavings
 * of the race (win / lose) are directly unit-testable without needing real
 * process concurrency — see spined-lock.test.ts.
 */
export function takeOverStaleLock(file: string): void {
  const staleName = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(file, staleName);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `spined: lost the race taking over a stale lock for '${file}' — another process claimed it first; ` +
          `fail closed (re-run acquireLock() if this persists — the winner should have a fresh lock in place now).`,
      );
    }
    throw new Error(`spined: cannot take over stale lockfile '${file}': ${(e as Error).message}`);
  }
  // We alone won the rename — the renamed-away file is now ours to discard;
  // best effort, harmless either way (nothing else can reference this path).
  try {
    fs.rmSync(staleName, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Acquire the per-ticket lock in `dir` (the ledger dir — one lock per
 * ticket, colocated with that ticket's spine-ledger.json). Throws a
 * fail-closed error naming the blocking pid when a live daemon already holds
 * it, or when an existing lock cannot be attributed to a definitely-dead
 * pid; otherwise creates (or takes over a stale) lock and returns a handle
 * whose release() removes it.
 */
export function acquireLock(dir: string): SpinedLock {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFilePath(dir);

  if (!tryCreate(file)) {
    const heldPid = readLockPid(file);
    if (heldPid === null) {
      throw new Error(
        `spined: lockfile '${file}' exists but is unreadable/corrupt — fail closed (refusing to guess ` +
          `whether another spined daemon is live for this ticket). Remove it manually only if you are ` +
          `certain no spined process is running for this ticket.`,
      );
    }
    if (isPidAlive(heldPid)) {
      throw new Error(
        `spined: another daemon (pid ${heldPid}) already holds the lock for this ticket at '${file}' — ` +
          `only one spined instance (one chat tab) per ticket is allowed. Close the other session first. ` +
          `(If you are certain pid ${heldPid} is NOT spined — e.g. the OS recycled a long-dead pid for an ` +
          `unrelated process — remove '${file}' manually and retry.)`,
      );
    }
    // Stale: the recorded pid is definitely dead. Take over ATOMICALLY (see
    // this file's header) — a losing racer throws here and must NOT fall
    // through to tryCreate() below.
    takeOverStaleLock(file);
    if (!tryCreate(file)) {
      // Vanishingly unlikely (we just won the rename race for this exact
      // path moments ago) but still handled: some OTHER process created a
      // brand-new file at `file` between our takeover and this tryCreate.
      // Fail closed rather than loop indefinitely.
      throw new Error(
        `spined: lost a race recreating '${file}' immediately after taking over a stale lock — ` +
          `another spined daemon just started for this ticket; fail closed.`,
      );
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only remove it if it is still OURS — defense in depth against a
      // takeover race where another process re-created the file after we
      // crashed and something else already took it over in the meantime.
      const heldPid = readLockPid(file);
      if (heldPid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* best effort — a leftover lock from a pid that is now dead is safely
         taken over by the next spined start (see acquireLock() above) */
    }
  };

  return { release };
}

/**
 * Read-only peek: could the per-ticket lock in `dir` be held by a LIVE
 * spined daemon right now? Used by spine-prepare (never by spined itself,
 * which always goes through the real `acquireLock()` above) to refuse
 * reseeding a ledger while a daemon might be running for this ticket —
 * WITHOUT taking over, mutating, or even creating the lock file (a read-only
 * check has no business doing any of that). Conservative by design: an
 * absent or definitely-stale (dead pid) lock reports `false` (safe to
 * proceed), but an UNREADABLE/corrupt lock also reports `true` ("cannot
 * prove it is safe") — the inverse of acquireLock()'s own default, because
 * here the caller (prepare.ts) is not the fail-closed authority for the
 * lock itself, only a cautious bystander that would rather over-refuse a
 * reseed than under-refuse one.
 */
export function isLockPotentiallyLive(dir: string): boolean {
  const file = lockFilePath(dir);
  if (!fs.existsSync(file)) return false;
  const heldPid = readLockPid(file);
  if (heldPid === null) return true; // unreadable/corrupt — cannot prove it's stale
  return isPidAlive(heldPid);
}
