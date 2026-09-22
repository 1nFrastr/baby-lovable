import {
  parseAllowedCommand,
  type AllowedCommand,
} from "./command-policy";

export type ExecKind = "inspect" | "pkg" | "skill-script";

export type ExecPolicyResult =
  | {
      ok: true;
      kind: ExecKind;
      allowed?: AllowedCommand;
      timeoutDefault: number;
    }
  | { ok: false; error: string };

export const EXEC_TIMEOUT_INSPECT_SEC = 30;
export const EXEC_TIMEOUT_MUTATING_SEC = 120;
export const EXEC_TIMEOUT_MAX_SEC = 180;

const DEV_SERVER_RE =
  /(?:^|[;&|\n]|&&|\|\|)\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?dev\b|\b(?:npx\s+)?next\s+dev\b/i;

const GIT_COMMAND_RE =
  /(?:^|[;&|\n]|&&|\|\||`|\$\()\s*git(?:\s|$)/;

const INPLACE_EDIT_RE = /\b(?:sed\s+-[A-Za-z]*i|perl\s+-i|ruby\s+-i|awk\s+-i)\b/;

const FILE_MUTATION_RE =
  /(?:^|[;&|\n]|&&|\|\|)\s*(?:rm|rmdir|mv|cp|touch|chmod|chown|truncate)\b/;

const TEE_RE = /(?:^|[;&|\n]|&&|\|\|)\s*tee\b/;

const SKILL_SCRIPT_RE =
  /(?:^|[;&|\n]|&&|\|\|)\s*(?:(?:bash|sh)\s+)?\.baby\/skills\/[a-z0-9_-]+\/scripts\/[A-Za-z0-9._-]+(?:\s|$)/;

const BABY_DISCOVERY_RE =
  /^(?:(?:bash|sh)\s+)?(?:\.baby\/bin\/)?baby(?:\s+(?:skills|skill\s+[a-z0-9_-]+))?\s*$/;

export const EXEC_DENY_HINTS = {
  empty: "Command is empty.",
  devServer:
    "The platform owns the preview lifecycle. Do not run pnpm/npm/next dev or background the app server. Use checkPreview (restart: true if the cache looks corrupt).",
  background:
    "Background jobs (&, nohup, disown) are not allowed. Run a foreground command, or use checkPreview for the managed preview.",
  git: "Do not run git in the sandbox. The platform syncs Freestyle. Use file tools for source changes.",
  mutateSource:
    "Do not mutate source with bash (sed -i, redirects, tee, rm, mv, cp). Use editFile, writeFile, or deleteFile so path guards and compileError stay intact.",
  managedPath:
    "Do not touch .next, node_modules, or .git. Use pnpm add/remove/install for dependencies, checkPreview({ restart: true }) for preview cache, and tail .baby/logs/preview.log for Next logs.",
} as const;

function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripRedirectionNoise(command: string): string {
  return command
    .replace(/\d*>&\d+/g, " ")
    .replace(/\d*>(?:\/dev\/null|\/dev\/stderr|\/dev\/stdout)\b/g, " ")
    .replace(/<(?:\/dev\/null)\b/g, " ");
}

function hasFileRedirect(command: string): boolean {
  const stripped = stripRedirectionNoise(command);
  return /(?:^|[^>])>(?!>)/.test(stripped) || />>/.test(stripped);
}

function hasBackgroundJob(command: string): boolean {
  if (/\bnohup\b|\bdisown\b/.test(command)) {
    return true;
  }
  const stripped = stripRedirectionNoise(command)
    .replace(/&&/g, " ")
    .replace(/>>/g, " ");
  return /(?:^|[\s;|])&(?:\s|$)/.test(stripped);
}

function touchesManagedTree(command: string): boolean {
  const withoutNegGlobs = command.replace(
    /!(?:\.\/)?(?:\.next|node_modules|\.git)\b/g,
    "",
  );
  if (
    /(?:^|[\s"'=`])(?:\.\/)?(?:\.next|node_modules|\.git)\//.test(
      withoutNegGlobs,
    )
  ) {
    return true;
  }
  const fileCmd =
    /(?:^|[;&|\n]|&&|\|\|)\s*(?:ls|ll|cat|less|tail|head|cd|find|tree|stat|du|realpath)\b/;
  return (
    fileCmd.test(withoutNegGlobs) &&
    /(?:^|[\s"'=`])(?:\.\/)?(?:\.next|node_modules|\.git)(?:\s|$|["'])/.test(
      withoutNegGlobs,
    )
  );
}

function denyReason(command: string): string | null {
  if (DEV_SERVER_RE.test(command)) {
    return EXEC_DENY_HINTS.devServer;
  }
  if (hasBackgroundJob(command)) {
    return EXEC_DENY_HINTS.background;
  }
  if (GIT_COMMAND_RE.test(command)) {
    return EXEC_DENY_HINTS.git;
  }
  if (
    INPLACE_EDIT_RE.test(command) ||
    hasFileRedirect(command) ||
    TEE_RE.test(command) ||
    FILE_MUTATION_RE.test(command)
  ) {
    return EXEC_DENY_HINTS.mutateSource;
  }
  if (touchesManagedTree(command)) {
    return EXEC_DENY_HINTS.managedPath;
  }
  return null;
}

function isSkillScriptCommand(command: string): boolean {
  return SKILL_SCRIPT_RE.test(command);
}

function isPkgCommand(command: string): AllowedCommand | undefined {
  const whole = parseAllowedCommand(command);
  if (whole) {
    return whole;
  }
  for (const segment of splitSegments(command)) {
    const pipeHead = segment.split("|")[0]?.trim() ?? "";
    const allowed = parseAllowedCommand(pipeHead);
    if (allowed) {
      return allowed;
    }
  }
  return undefined;
}

/**
 * Decide whether a sandbox bash command may run.
 * Inspect/composition is allowed; source mutation and preview lifecycle are not.
 */
export function evaluateExecPolicy(command: string): ExecPolicyResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, error: EXEC_DENY_HINTS.empty };
  }

  const denied = denyReason(trimmed);
  if (denied) {
    return { ok: false, error: denied };
  }

  if (isSkillScriptCommand(trimmed)) {
    return {
      ok: true,
      kind: "skill-script",
      timeoutDefault: EXEC_TIMEOUT_MUTATING_SEC,
    };
  }

  const allowed = isPkgCommand(trimmed);
  if (allowed) {
    return {
      ok: true,
      kind: "pkg",
      allowed,
      timeoutDefault: EXEC_TIMEOUT_MUTATING_SEC,
    };
  }

  if (BABY_DISCOVERY_RE.test(trimmed)) {
    return {
      ok: true,
      kind: "inspect",
      timeoutDefault: EXEC_TIMEOUT_INSPECT_SEC,
    };
  }

  return {
    ok: true,
    kind: "inspect",
    timeoutDefault: EXEC_TIMEOUT_INSPECT_SEC,
  };
}

export function capExecTimeout(timeoutSec: number): number {
  if (!Number.isFinite(timeoutSec)) {
    return EXEC_TIMEOUT_INSPECT_SEC;
  }
  return Math.min(EXEC_TIMEOUT_MAX_SEC, Math.max(1, Math.floor(timeoutSec)));
}
