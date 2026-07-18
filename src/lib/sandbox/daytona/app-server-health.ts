/** App-server health: probe helpers and log / compile-error parsing. */
import { isUnreliableCompileError } from "../preview-errors";
import type { DaytonaProjectSandbox } from "./provider";

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
): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: token ? { "x-daytona-preview-token": token } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    return res.status;
  } catch {
    return 503;
  }
}
