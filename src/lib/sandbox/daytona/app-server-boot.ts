/** App-server boot: atomic install / start / stop (no orchestration loops). */
import { logDaytonaBootstrap } from "./bootstrap-log";
import { DAYTONA_WORKSPACE_ROOT, getDaytonaDevPort } from "./config";
import { resolvePackageManager } from "../package-manager";
import type { DaytonaProjectSandbox } from "./provider";

export const DEV_SESSION = (sessionId: string) => `preview-${sessionId}`;

export function formatStartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/disk limit exceeded/i.test(raw) || /Total disk limit/i.test(raw)) {
    return "Daytona 磁盘配额已满（上限 30GiB）。请联系作者清理闲置 Sandbox 后再试。";
  }
  const trimmed = raw.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, 500)
    : "Daytona 预览启动失败，请稍后重试或联系作者。";
}

export async function installDeps(
  sandbox: DaytonaProjectSandbox,
  sessionId: string,
): Promise<void> {
  const pm = resolvePackageManager("daytona");
  logDaytonaBootstrap(sessionId, "preview", pm.install);
  const result = await sandbox.process.executeCommand(pm.install, ".", undefined, 600);
  if (result.exitCode !== 0) {
    const detail =
      (result.stdout || result.stderr || "").trim() || "unknown install failure";
    throw new Error(`pnpm install failed: ${detail.slice(-2000)}`);
  }
}

/**
 * Create remote dev session and start `pnpm dev`.
 * Does not wait for preview readiness — reconciler + observer handle that.
 */
export async function startDevSession(
  sandbox: DaytonaProjectSandbox,
  sessionId: string,
): Promise<{ sessionName: string; port: number }> {
  const sdk = sandbox.sdkSandbox;
  const port = getDaytonaDevPort();
  const pm = resolvePackageManager("daytona");
  const sessionName = DEV_SESSION(sessionId);

  logDaytonaBootstrap(sessionId, "preview", `dev ${pm.dev(port)} on ${sdk.id}`);

  try {
    await sdk.process.deleteSession(sessionName);
  } catch {
    // may not exist
  }

  await sdk.process.createSession(sessionName);
  await sdk.process.executeSessionCommand(
    sessionName,
    {
      command: `cd ${JSON.stringify(DAYTONA_WORKSPACE_ROOT)} && ${pm.dev(port)}`,
      runAsync: true,
    },
    30,
  );

  return { sessionName, port };
}

/** Stop remote preview session. Does not clear runtime preview cache. */
export async function stopDevSession(
  sandbox: DaytonaProjectSandbox | null,
  sessionId: string,
): Promise<void> {
  if (!sandbox) {
    return;
  }
  try {
    await sandbox.sdkSandbox.process.deleteSession(DEV_SESSION(sessionId));
  } catch {
    // best effort
  }
}

/** @deprecated Use startDevSession — kept name alias during migration. */
export const startDevServer = startDevSession;
