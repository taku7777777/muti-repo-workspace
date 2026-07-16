/**
 * server.ts — thin node:http wiring around routes.ts's handleRequest,
 * mirroring broker/src/server.ts's own split (framing/transport here,
 * decision procedure in routes.ts/handler.ts respectively).
 *
 * `createServer()` is CONSTRUCTIBLE WITHOUT LISTENING (§3 Tests: "Keep the
 * server constructible without listening ... so tests don't fight over
 * ports") — it returns a plain http.Server; callers decide when/whether to
 * call .listen().
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrokerClient } from "./broker-client.js";
import type { ServeConfig } from "./config.js";
import { handleRequest, type ServeContext } from "./routes.js";
import { csrfTokenFor } from "./security.js";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(thisDir, "assets");

export interface CreateServerOptions {
  sessionToken: string;
  broker: BrokerClient;
  config: ServeConfig;
  configDir: string | null;
}

export function createServer(opts: CreateServerOptions): http.Server {
  const ctx: ServeContext = {
    sessionToken: opts.sessionToken,
    csrf: csrfTokenFor(opts.sessionToken),
    broker: opts.broker,
    config: opts.config,
    configDir: opts.configDir,
    appJs: fs.readFileSync(path.join(ASSETS_DIR, "app.js"), "utf8"),
    appCss: fs.readFileSync(path.join(ASSETS_DIR, "app.css"), "utf8"),
  };

  return http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((e: unknown) => {
      try {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("internal error");
      } catch {
        /* peer already gone */
      }
      console.error(`[serve] unhandled request error: ${(e as Error).message}`);
    });
  });
}
