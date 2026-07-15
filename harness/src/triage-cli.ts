/**
 * triage-cli.ts — CLI entrypoint for the triage leaf (`npm run triage --`,
 * see package.json). Reads ticket text from `--text-file <path>` or, if
 * absent, stdin; classifies it via runTriage(); prints the validated
 * {work_type,title,repos,summary} object as JSON to stdout — nothing else on
 * stdout (all logging goes to stderr) so a caller (mrw task-up, via
 * spawnSync) can treat stdout as pure JSON. Non-zero exit on any failure.
 *
 * Auth: this process inherits its environment; the CALLER must set
 * CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (same as every other harness
 * entrypoint — see sdk.ts's baseOptions). This file deliberately does NOT
 * read the macOS keychain itself; that fallback lives in cli/mrw.mjs, which
 * exports the resolved token into THIS process's env before spawning it.
 */
import * as fs from "node:fs";
import { runTriage } from "./triage.js";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let textFile: string | null = null;
  let reposArg = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text-file") {
      textFile = argv[++i] ?? null;
      if (textFile === null) throw new Error("--text-file requires a value");
    } else if (a === "--repos") {
      reposArg = argv[++i] ?? "";
    } else {
      throw new Error(`unrecognized argument: ${a}`);
    }
  }

  const ticketText = textFile ? fs.readFileSync(textFile, "utf8") : await readStdin();
  if (!ticketText.trim()) {
    throw new Error("no ticket text provided (--text-file was empty/missing, and stdin was empty)");
  }

  const availableRepos = reposArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const triage = await runTriage(ticketText, availableRepos);
  // ONLY the validated JSON goes to stdout.
  process.stdout.write(JSON.stringify(triage) + "\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`triage failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
