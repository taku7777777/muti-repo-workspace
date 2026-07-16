/**
 * Remove values left unexpanded by an env-template interpolator.
 *
 * Each name is compared only with its own `${NAME}` placeholder, so a value
 * that happens to reference a different variable is left untouched. The
 * supplied object is mutated in place so callers may sanitize process.env
 * before passing it to child processes or libraries that read it later.
 */
export function sanitizeUnexpandedEnvPlaceholders(env: NodeJS.ProcessEnv, names: string[]): void {
  for (const name of names) {
    if (env[name] === `\${${name}}`) delete env[name];
  }
}
