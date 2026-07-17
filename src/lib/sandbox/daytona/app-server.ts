/** App-server API: status / start / stop / check (preview URL layer). */
import type { AppServerCheck, AppServerStatus } from "../preview-types";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import {
  getExistingDaytonaSandbox,
  getOrCreateDaytonaSandbox,
} from "./sandbox";
import {
  extractCompileError,
  httpStatus,
  probePreview,
  readDevLog,
  remoteFileExists,
} from "./app-server-health";
import {
  formatStartError,
  runStart,
  startDevServer,
  stopDevSession,
} from "./app-server-boot";

export async function hasDaytonaNodeModules(sessionId: string): Promise<boolean> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  return remoteFileExists(sandbox, "node_modules/next/package.json");
}

export async function getDaytonaBuildError(
  sessionId: string,
): Promise<string | null> {
  const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: false });
  if (!sandbox) {
    return null;
  }
  return extractCompileError(await readDevLog(sandbox));
}

/** Read-only status. Never creates or wakes a stopped sandbox. */
export async function getDaytonaAppServerStatus(
  sessionId: string,
): Promise<AppServerStatus> {
  const ready = await probePreview(sessionId);
  if (ready) {
    return { status: "ready", url: ready.url, port: ready.port };
  }

  const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: false });
  if (!sandbox) {
    return { status: "stopped" };
  }
  if (!(await remoteFileExists(sandbox, "package.json"))) {
    return { status: "needs_install" };
  }
  return { status: "stopped" };
}

/** Fire-and-forget start (remote work continues if this isolate exits). */
export function startDaytonaPreview(sessionId: string): void {
  void runStart(sessionId).catch((error) => {
    logDaytonaBootstrap(
      sessionId,
      "preview",
      `start failed: ${formatStartError(error).slice(0, 200)}`,
    );
  });
}

export async function startDaytonaAppServer(
  sessionId: string,
  options?: { wait?: boolean },
): Promise<AppServerStatus> {
  if (!(options?.wait ?? false)) {
    const current = await getDaytonaAppServerStatus(sessionId);
    if (current.status === "ready") {
      return current;
    }
    startDaytonaPreview(sessionId);
    if (current.status === "needs_install") {
      return current;
    }
    return { status: "starting", port: getDaytonaDevPort() };
  }

  try {
    return await runStart(sessionId);
  } catch (error) {
    return { status: "error", error: formatStartError(error) };
  }
}

export async function stopDaytonaAppServer(sessionId: string): Promise<void> {
  await stopDevSession(sessionId);
}

export async function restartDaytonaAppServer(
  sessionId: string,
): Promise<AppServerStatus> {
  await stopDevSession(sessionId);

  try {
    const sandbox = await getOrCreateDaytonaSandbox(sessionId);
    try {
      await sandbox.process.executeCommand("rm -rf .next", ".", undefined, 60);
    } catch {
      // best effort
    }
    return await startDevServer(sandbox, sessionId);
  } catch (error) {
    return { status: "error", error: formatStartError(error) };
  }
}

/** Health check only — never create/start sandbox. */
export async function checkDaytonaAppServer(
  sessionId: string,
): Promise<AppServerCheck> {
  const probed = await probePreview(sessionId);

  if (!probed) {
    const status = await getDaytonaAppServerStatus(sessionId);
    return {
      status: status.status,
      url: status.status === "ready" ? status.url : undefined,
      buildError:
        status.status === "error"
          ? (status.error ?? "Preview failed to start in Daytona sandbox")
          : null,
    };
  }

  let http = await httpStatus(probed.probeUrl, probed.token);
  let buildError = extractCompileError(await readDevLog(probed.sandbox));

  if (!buildError && http < 500) {
    buildError = null;
  } else if (!buildError && http >= 500) {
    await new Promise((r) => setTimeout(r, 2_000));
    http = await httpStatus(probed.probeUrl, probed.token);
    buildError =
      http < 500
        ? null
        : `Preview returned HTTP ${http} but no compile error was captured.`;
  }

  return {
    status: "ready",
    url: probed.url,
    httpStatus: http,
    buildError,
  };
}
