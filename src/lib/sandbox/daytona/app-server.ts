/** App-server API shim: status / start / stop / check → reconciler. */
import type { AppServerCheck, AppServerStatus } from "../preview-types";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { formatStartError } from "./app-server-boot";
import {
  checkRuntimePreview,
  ensureDesiredState,
  readRuntime,
  readRuntimeAppServerStatus,
} from "./runtime-reconciler";
import { deriveAppServerStatus } from "./runtime-state";
import { getExistingDaytonaSandbox } from "./sandbox";
import { extractCompileError, readDevLog } from "./app-server-health";
import { getDaytonaDevPort } from "./config";

/** Snapshot bakes node_modules — Daytona never gates on runtime dep install. */
export async function hasDaytonaNodeModules(_sessionId: string): Promise<boolean> {
  return true;
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
  return readRuntimeAppServerStatus(sessionId);
}

/** Fire-and-forget: submit desired=preview-ready. */
export function startDaytonaPreview(sessionId: string): void {
  void ensureDesiredState(sessionId, "preview-ready", { wait: false }).catch(
    (error) => {
      logDaytonaBootstrap(
        sessionId,
        "preview",
        `start failed: ${formatStartError(error).slice(0, 200)}`,
      );
    },
  );
}

export async function startDaytonaAppServer(
  sessionId: string,
  options?: { wait?: boolean },
): Promise<AppServerStatus> {
  const wait = options?.wait ?? false;

  if (!wait) {
    const current = await getDaytonaAppServerStatus(sessionId);
    if (current.status === "ready") {
      return current;
    }
    startDaytonaPreview(sessionId);
    return { status: "starting", port: getDaytonaDevPort() };
  }

  try {
    const snapshot = await ensureDesiredState(sessionId, "preview-ready", {
      wait: true,
    });
    return deriveAppServerStatus(snapshot);
  } catch (error) {
    return { status: "error", error: formatStartError(error) };
  }
}

export async function stopDaytonaAppServer(sessionId: string): Promise<void> {
  await ensureDesiredState(sessionId, "stopped", { wait: true });
}

export async function restartDaytonaAppServer(
  sessionId: string,
): Promise<AppServerStatus> {
  try {
    const snapshot = await ensureDesiredState(sessionId, "preview-ready", {
      wait: true,
      restart: true,
    });
    return deriveAppServerStatus(snapshot);
  } catch (error) {
    return { status: "error", error: formatStartError(error) };
  }
}

/** Health check only — never create/start sandbox. */
export async function checkDaytonaAppServer(
  sessionId: string,
): Promise<AppServerCheck> {
  const result = await checkRuntimePreview(sessionId);
  return {
    status: result.status,
    url: result.url,
    httpStatus: result.httpStatus,
    buildError: result.buildError,
  };
}

/** Expose snapshot read for debugging / future callers. */
export { readRuntime };
