/** App-server API: status / start / stop / check (preview URL layer). */
import type { AppServerCheck, AppServerStatus } from "../preview-types";
import {
  clearNextCache,
  getLocalAppServerMemoryStatus,
  kickOffBootstrap,
  resolveActivePreviewUrl,
  runStart,
  stopDevSession,
  waitForInFlightStart,
} from "./app-server-boot";
import {
  getLocalBuildError,
  probePreviewCompile,
  readLatestDevLogServerError,
  setLocalBuildError,
} from "./app-server-health";

export type { AppServerStatus };

export {
  getLocalBuildError,
  getDevServerLog,
} from "./app-server-health";

export {
  hasLocalNodeModules,
  sessionPort,
  ensureDependencies,
} from "./app-server-boot";

async function publishLocalPreview(
  sessionId: string,
  options?: { bumpGeneration?: boolean },
): Promise<void> {
  try {
    const { syncPreviewRuntimeProjection } = await import(
      "@/lib/session/runtime-projection-store"
    );
    await syncPreviewRuntimeProjection(sessionId, options);
  } catch {
    // Best-effort
  }
}

export async function stopLocalAppServer(sessionId: string): Promise<void> {
  await stopDevSession(sessionId);
  void publishLocalPreview(sessionId);
}

export async function startLocalAppServer(
  sessionId: string,
): Promise<AppServerStatus> {
  const status = await runStart(sessionId);
  void publishLocalPreview(sessionId);
  return status;
}

/**
 * Start installing dependencies and booting the dev server in the background
 * (idempotent). Call this at the beginning of an agent turn so the preview is
 * warming up in parallel with codegen.
 */
export function startLocalPreview(sessionId: string): void {
  kickOffBootstrap(sessionId);
  // Bootstrap mutates status asynchronously — sync once kicked, again when ready.
  void publishLocalPreview(sessionId);
  void (async () => {
    await waitForInFlightStart(sessionId, getLocalAppServerStatus);
    await publishLocalPreview(sessionId);
  })();
}

export async function restartLocalAppServer(
  sessionId: string,
): Promise<AppServerStatus> {
  await stopDevSession(sessionId);
  await clearNextCache(sessionId);
  const status = await runStart(sessionId);
  void publishLocalPreview(sessionId, { bumpGeneration: true });
  return status;
}

/**
 * Check app server health only — never install or start.
 * Call startPreview at agent turn start first.
 */
export async function checkLocalAppServer(
  sessionId: string,
): Promise<AppServerCheck> {
  const resolved = await waitForInFlightStart(sessionId, getLocalAppServerStatus);

  let buildError = getLocalBuildError(sessionId);
  let httpStatus: number | undefined;

  if (resolved.status === "ready") {
    const probe = await probePreviewCompile(sessionId, resolved.url);
    httpStatus = probe.httpStatus ?? undefined;
    buildError = probe.buildError;
    if (!buildError && httpStatus !== undefined && httpStatus >= 500) {
      buildError =
        (await readLatestDevLogServerError(sessionId)) ??
        `Preview returned HTTP ${httpStatus} but no compile error was captured. Inspect source files or call checkPreview with restart: true.`;
    }
    setLocalBuildError(sessionId, buildError);
  }

  return {
    status: resolved.status,
    url: resolved.status === "ready" ? resolved.url : undefined,
    httpStatus,
    buildError,
  };
}

/** Read-only local app server status. Does not install or start. */
export async function getLocalAppServerStatus(
  sessionId: string,
): Promise<AppServerStatus> {
  const active = await resolveActivePreviewUrl(sessionId);
  if (active) {
    return { status: "ready", url: active.url, port: active.port };
  }

  return getLocalAppServerMemoryStatus(sessionId);
}
