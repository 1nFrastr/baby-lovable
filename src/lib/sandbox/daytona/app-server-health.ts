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

export function extractCompileError(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!COMPILE_MARKERS.some((m) => m.test(line))) {
      continue;
    }
    const slice = lines.slice(Math.max(0, i - 2), i + 12).join("\n");
    if (!isUnreliableCompileError(slice)) {
      return slice.trim();
    }
  }
  return null;
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
