/** App-server health: probe helpers and log / compile-error parsing. */
import { isUnreliableCompileError } from "../preview-errors";
import type { DaytonaProjectSandbox } from "./provider";

/**
 * Short HTTP probe while Next may still be booting.
 * Ready responds in ms; hang/timeout ≈ not ready (expect 502 / connection fail).
 */
export const PREVIEW_HTTP_TIMEOUT_MS = 1_500;

/**
 * Light-probe timeout while `starting-devserver`.
 * Must stay ≥ {@link PREVIEW_HTTP_TIMEOUT_MS}: Daytona proxy RTT often exceeds a
 * sub-second abort even after Next already logged `GET / 200` inside the VM.
 * Aborting early maps to 503 and the UI never leaves "starting".
 */
export const STARTING_DEV_HTTP_TIMEOUT_MS = PREVIEW_HTTP_TIMEOUT_MS;

const COMPILE_MARKERS = [
  /Parsing CSS source code failed/i,
  /Failed to compile/i,
  /Module not found/i,
  /⨯ \.\//,
  /Turbopack build failed/i,
  /Event handlers cannot be passed/i,
  /Client Component props/i,
  /You're importing a component that needs/i,
  /Server Actions must be async/i,
  /⨯ Error:/,
];

/** Runtime / SSR failures that still produce a real Next HTTP 500 (not compile). */
const RUNTIME_MARKERS = [
  /Failed prop type/i,
  /\bdigest:\s*['"]?[0-9A-Fa-f]+/,
  /Unhandled Runtime Error/i,
  /Application error:/i,
  /⨯ Error:/,
  /Error: .*<\/Link>/i,
  /TypeError:\s/i,
  /ReferenceError:\s/i,
];

/** Access-log 5xx — weaker signal; used only when no richer error marker exists. */
const ACCESS_LOG_5XX = /GET\s+\S+\s+5\d\d\b/;

const PRIMARY_PREVIEW_ERROR_MARKERS = [
  ...COMPILE_MARKERS,
  ...RUNTIME_MARKERS,
];

export async function remoteFileExists(
  sandbox: DaytonaProjectSandbox,
  path: string,
): Promise<boolean> {
  try {
    await sandbox.fs.getFileDetails(path);
    return true;
  } catch {
    return false;
  }
}

export async function readDevLog(sandbox: DaytonaProjectSandbox): Promise<string> {
  try {
    return await sandbox.fs.readTextFile(".next/dev/logs/next-development.log");
  } catch {
    return "";
  }
}

function extractErrorWithMarkers(
  content: string,
  markers: RegExp[],
  lookback = 2,
  lookahead = 12,
): string | null {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!markers.some((m) => m.test(line))) {
      continue;
    }
    const slice = lines
      .slice(Math.max(0, i - lookback), i + lookahead)
      .join("\n");
    if (!isUnreliableCompileError(slice)) {
      return slice.trim();
    }
  }
  return null;
}

/** Compile / Turbopack failures from the Next development log. */
export function extractCompileError(content: string): string | null {
  return extractErrorWithMarkers(content, COMPILE_MARKERS);
}

/**
 * Compile or runtime/SSR error excerpt from the Next development log.
 * Used by checkPreview when HTTP is 5xx so the agent sees the failure instead
 * of treating a stable application 500 as "still starting".
 *
 * Prefer rich error markers over bare `GET / 5xx` access lines so the excerpt
 * includes the stack / prop-type message above the access log.
 */
export function extractPreviewError(content: string): string | null {
  return (
    extractErrorWithMarkers(content, PRIMARY_PREVIEW_ERROR_MARKERS) ??
    extractErrorWithMarkers(content, [ACCESS_LOG_5XX], 8, 4)
  );
}

/**
 * True when the log shows Next already served a 5xx (access line), i.e. the
 * process is up and answering — not a Daytona proxy cold-start 502.
 */
export function hasNextAccessLog5xx(content: string): boolean {
  return /GET\s+\S+\s+5\d\d\b/.test(content);
}

/**
 * Classify a 5xx probe: application error (fix) vs proxy / still booting.
 * - HTTP 500 → application (Daytona boot hang maps to 502/503, not 500)
 * - 502/503 → application only when the Next log shows a 5xx / error excerpt
 */
export function isApplicationPreviewFailure(
  httpStatus: number,
  logContent: string,
): boolean {
  if (httpStatus === 500) {
    return true;
  }
  if (httpStatus < 500) {
    return false;
  }
  return (
    extractPreviewError(logContent) !== null || hasNextAccessLog5xx(logContent)
  );
}

export async function httpStatus(
  url: string,
  token?: string,
  timeoutMs: number = PREVIEW_HTTP_TIMEOUT_MS,
): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: token ? { "x-daytona-preview-token": token } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch {
    // Timeout / DNS / connection fail. Callers must treat this like a
    // transient 503 (Next compiling), not a dead proxy (that's a real 502).
    return 503;
  }
}
