/**
 * Host env passed into a standalone web-skill script.
 * Chained shells (`&&`, pipes, `$()`) get nothing, so the key cannot be
 * expanded by a command the model appends.
 */

const WEB_SCRIPT_RE =
  /^(?:bash|sh)\s+\.baby\/skills\/web\/scripts\/(?:search|fetch)\.sh(?:\s|$)/;

const SHELL_META_RE = /[;&|`$\\\n]/;

export function keenableExecEnv(
  command: string,
): Record<string, string> | undefined {
  const trimmed = command.trim();
  if (!WEB_SCRIPT_RE.test(trimmed) || SHELL_META_RE.test(trimmed)) {
    return undefined;
  }
  const env: Record<string, string> = {
    KEENABLE_APP_TITLE: "baby-lovable",
  };
  const key = process.env.KEENABLE_API_KEY?.trim();
  if (key) {
    env.KEENABLE_API_KEY = key;
  }
  return env;
}
