import type { PreviewStatus } from "./dev-server";
import {
  ensurePreviewBootstrap as ensureLocalPreviewBootstrap,
  getPreviewReport as getLocalPreviewReport,
  isTransientPreviewFailure as isLocalTransientPreviewFailure,
  restartDevServer as restartLocalDevServer,
  stopDevServer as stopLocalDevServer,
  type PreviewReport,
} from "./dev-server";
import {
  destroyDaytonaPreview,
  ensureDaytonaPreviewBootstrap,
  getDaytonaBuildError,
  getDaytonaPreviewReport,
} from "./dev-server-daytona";
import { getSession } from "@/lib/session/store";
import { getBuildError as getLocalBuildError } from "./dev-server";

async function sandboxModeFor(sessionId: string) {
  const session = await getSession(sessionId);
  return session?.sandboxMode ?? "local";
}

export function ensurePreviewBootstrap(sessionId: string): void {
  void sandboxModeFor(sessionId).then((mode) => {
    if (mode === "daytona") {
      ensureDaytonaPreviewBootstrap(sessionId);
      return;
    }
    ensureLocalPreviewBootstrap(sessionId);
  });
}

/**
 * Read the in-memory preview compile error without waiting for install/dev-server
 * bootstrap. Use at agent turn start; call getPreviewReport from checkPreview when
 * a full status probe is needed.
 */
export async function getCachedPreviewBuildError(
  sessionId: string,
): Promise<string | null> {
  const mode = await sandboxModeFor(sessionId);
  if (mode === "daytona") {
    return getDaytonaBuildError(sessionId);
  }
  return getLocalBuildError(sessionId);
}

export async function getPreviewReport(
  sessionId: string,
  options?: { restart?: boolean },
): Promise<PreviewReport> {
  const mode = await sandboxModeFor(sessionId);
  if (mode === "daytona") {
    return getDaytonaPreviewReport(sessionId, options);
  }
  return getLocalPreviewReport(sessionId, options);
}

export async function restartDevServer(sessionId: string): Promise<PreviewStatus> {
  const mode = await sandboxModeFor(sessionId);
  if (mode === "daytona") {
    const { restartDaytonaDevServer } = await import("./dev-server-daytona");
    return restartDaytonaDevServer(sessionId);
  }
  return restartLocalDevServer(sessionId);
}

export async function stopDevServer(sessionId: string): Promise<void> {
  const mode = await sandboxModeFor(sessionId);
  if (mode === "daytona") {
    await destroyDaytonaPreview(sessionId);
    return;
  }
  await stopLocalDevServer(sessionId);
}

export function isTransientPreviewFailure(report: PreviewReport): boolean {
  return isLocalTransientPreviewFailure(report);
}

export type { PreviewReport, PreviewStatus };
