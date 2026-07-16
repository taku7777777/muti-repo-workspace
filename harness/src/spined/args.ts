/**
 * spined/args.ts — argv parsing shared by spined's two entrypoints
 * (index.ts's daemon, prepare.ts's prepare step).
 *
 * Mirrors spine/index.ts's parseChatArgs SHAPE exactly (--ticket/--repos/
 * --purpose flags, rest = free-text instruction) so a launcher can build ONE
 * argv list (docs/mrw-chat.md: "receives --ticket/--repos/--purpose on argv
 * from the generated config") and pass it to prepare.ts verbatim, then reuse
 * just the --ticket (and, for logging, --repos/--purpose) portion for
 * spined's own daemon startup. Deliberately a SEPARATE small implementation,
 * not an import of spine/index.ts's parseChatArgs — that file is out of this
 * phase's file scope (docs/mrw-chat.md Phase C2 hard constraints list what
 * C2 may touch; spine/index.ts is not on it), and spine/index.ts's own header
 * already established the norm of re-implementing ~20 lines of flag parsing
 * per entrypoint rather than coupling entrypoints together.
 */
export interface SpinedArgs {
  ticket: string;
  purpose: string;
  repos: string[];
  /** Rest args joined — the initial human instruction, if given up front.
   *  Only meaningful to prepare.ts (it persists this into the ledger via
   *  SpineLedger.setInstruction()); spined's daemon (index.ts) ignores it —
   *  the daemon LOADS the already-persisted instruction instead. */
  instruction: string;
  /** --force: a bare boolean flag (no value). Only meaningful to prepare.ts
   *  — it bypasses the "a ledger already exists" reseed refusal (see
   *  prepare.ts's header on why that refusal exists). Parsed here anyway so
   *  the SAME argv list a launcher builds for prepare.ts can be reused
   *  verbatim for spined's own startup without spined choking on an unknown
   *  flag; spined's daemon (index.ts) never reads this field. */
  force: boolean;
}

export function parseSpinedArgs(argv: string[]): SpinedArgs {
  let ticket = "";
  let purpose = "";
  let repos: string[] = [];
  let force = false;
  const rest: string[] = [];

  const takeValue = (inline: string | undefined, i: number): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const next = argv[i + 1];
    if (next === undefined) throw new Error("missing value for a flag");
    return [next, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eq = tok.indexOf("=");
    const flag = tok.startsWith("--") ? (eq >= 0 ? tok.slice(0, eq) : tok) : "";
    const inline = tok.startsWith("--") && eq >= 0 ? tok.slice(eq + 1) : undefined;
    if (flag === "--ticket") {
      [ticket, i] = takeValue(inline, i);
    } else if (flag === "--purpose") {
      [purpose, i] = takeValue(inline, i);
    } else if (flag === "--repos") {
      let csv: string;
      [csv, i] = takeValue(inline, i);
      repos = csv.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (flag === "--force") {
      force = true; // bare flag — any inline value (e.g. --force=x) is ignored
    } else {
      rest.push(tok);
    }
  }

  return { ticket, purpose, repos, instruction: rest.join(" ").trim(), force };
}
