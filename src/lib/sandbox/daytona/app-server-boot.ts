/** App-server boot: pnpm install + start/stop remote `pnpm dev`. */
import type { AppServerStatus } from "../preview-types";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { DAYTONA_WORKSPACE_ROOT, getDaytonaDevPort } from "./config";
import {
  getExistingDaytonaSandbox,
  getOrCreateDaytonaSandbox,
} from "./sandbox";
import { resolvePackageManager } from "../package-manager";
import type { DaytonaProjectSandbox } from "./provider";
import {
  probePreview,
  remoteFileExists,
  signedEmbedUrl,
} from "./app-server-health";

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

async function installDeps(
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

/** Start remote pnpm dev and wait until preview responds (or timeout). */
export async function startDevServer(
  sandbox: DaytonaProjectSandbox,
  sessionId: string,
): Promise<AppServerStatus> {
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

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const preview = await sdk.getPreviewLink(port);
      const res = await fetch(preview.url, {
        headers: { "x-daytona-preview-token": preview.token },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status < 600) {
        const embed = await signedEmbedUrl(sdk, port);
        return { status: "ready", url: embed ?? preview.url, port };
      }
    } catch {
      // warming up
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return {
    status: "error",
    error: "Timed out waiting for Daytona preview to become ready",
  };
}

/** Install if needed + start dev. Reuses healthy preview when present. */
export async function runStart(sessionId: string): Promise<AppServerStatus> {
  const already = await probePreview(sessionId);
  if (already) {
    return { status: "ready", url: already.url, port: already.port };
  }

  const sandbox = await getOrCreateDaytonaSandbox(sessionId);

  if (!(await remoteFileExists(sandbox, "package.json"))) {
    return { status: "needs_install" };
  }

  if (!(await remoteFileExists(sandbox, "node_modules/next/package.json"))) {
    await installDeps(sandbox, sessionId);
  }

  const again = await probePreview(sessionId);
  if (again) {
    return { status: "ready", url: again.url, port: again.port };
  }

  return startDevServer(sandbox, sessionId);
}

export async function stopDevSession(sessionId: string): Promise<void> {
  const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: false });
  if (!sandbox) {
    return;
  }
  try {
    await sandbox.sdkSandbox.process.deleteSession(DEV_SESSION(sessionId));
  } catch {
    // best effort
  }
}
