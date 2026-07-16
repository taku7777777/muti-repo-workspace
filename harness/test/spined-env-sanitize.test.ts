import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeUnexpandedEnvPlaceholders } from "../src/spined/env-sanitize.js";

test("strips a variable's exact self-referential placeholder", () => {
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" };

  sanitizeUnexpandedEnvPlaceholders(env, ["ANTHROPIC_API_KEY"]);

  assert.equal("ANTHROPIC_API_KEY" in env, false);
});

test("leaves a real-looking token and unrelated variables untouched", () => {
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real-looking-token",
    UNRELATED: "${UNRELATED}",
  };

  sanitizeUnexpandedEnvPlaceholders(env, ["CLAUDE_CODE_OAUTH_TOKEN"]);

  assert.deepEqual(env, {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real-looking-token",
    UNRELATED: "${UNRELATED}",
  });
});

test("strips only the poisoned credential when the other is real", () => {
  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real-looking-token",
  };

  sanitizeUnexpandedEnvPlaceholders(env, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);

  assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real-looking-token" });
});
