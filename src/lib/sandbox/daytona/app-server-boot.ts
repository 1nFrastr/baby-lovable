/** App-server boot: start / stop (no runtime pnpm / node_modules install). */
import { logDaytonaBootstrap } from "./bootstrap-log";
import { DAYTONA_WORKSPACE_ROOT, getDaytonaDevPort } from "./config";
import { resolvePackageManager } from "../package-manager";
import type { DaytonaProjectSandbox } from "./provider";

export const DEV_SESSION = (sessionId: string) => `preview-${sessionId}`;

export function formatStartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/disk limit exceeded/i.test(raw) || /Total disk limit/i.test(raw)) {
    return "Daytona disk quota is full (30 GiB limit). Contact the author to clean up idle sandboxes, then try again.";
  }
  const trimmed = raw.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, 500)
    : "Daytona preview failed to start. Please try again later or contact the author.";
}

/**
 * Create remote dev session and start `pnpm dev`.
 * Snapshot must already include pnpm + node_modules — no runtime install.
 */
export async function startDevSession(
  sandbox: DaytonaProjectSandbox,
  sessionId: string,
): Promise<{ sessionName: string; port: number; cmdId: string | null }> {
  const sdk = sandbox.sdkSandbox;
  const port = getDaytonaDevPort();
  const pm = resolvePackageManager();
  const sessionName = DEV_SESSION(sessionId);

  logDaytonaBootstrap(sessionId, "preview", `dev ${pm.dev(port)} on ${sdk.id}`);

  try {
    await sdk.process.deleteSession(sessionName);
  } catch {
    // may not exist
  }

  await sdk.process.createSession(sessionName);
  const cmd = await sdk.process.executeSessionCommand(
    sessionName,
    {
      command: `cd ${JSON.stringify(DAYTONA_WORKSPACE_ROOT)} && ${pm.dev(port)}`,
      runAsync: true,
    },
    30,
  );

  let cmdId = cmd.cmdId ?? null;
  if (!cmdId) {
    // Some SDK responses omit cmdId on runAsync — recover from session listing.
    try {
      const session = await sdk.process.getSession(sessionName);
      const last = session.commands?.[session.commands.length - 1];
      cmdId = last?.id ?? null;
    } catch {
      // keep null
    }
  }

  logDaytonaBootstrap(
    sessionId,
    "preview",
    `dev session=${sessionName} cmdId=${cmdId ?? "null"}`,
  );

  return { sessionName, port, cmdId };
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
