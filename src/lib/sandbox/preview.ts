/**
 * Preview API — one place for callers.
 *
 * Three layers: sandbox → appServer → previewUrl
 *
 * Read:  getSandboxStatus / getAppServerStatus / getPreviewUrlStatus / getAllStatus
 *        peekAllStatus (durable snapshot, no remote probe) / checkAppServer / getBuildError
 * Write: startPreview / warmPreview / startAppServer / restartAppServer / stopAppServer / deleteSandbox
 *
 * Mode (local | daytona) is chosen once via createPreviewBackend / getPreviewBackend.
 */

import { getSession } from "@/lib/session/store";
import { createPreviewBackend, getPreviewBackend } from "./preview-backend";
import { isTempFailure as isLocalTempFailure } from "./preview-errors";
import type {
  AllStatus,
  AppServerCheck,
  AppServerStatus,
  PreviewUrlStatus,
  SandboxStatus,
} from "./preview-types";

function previewUrlFromAppServer(appServer: AppServerStatus): PreviewUrlStatus {
  if (appServer.status === "ready") {
    return { status: "ready", url: appServer.url };
  }
  if (appServer.status === "starting" && appServer.url) {
    return { status: "ready", url: appServer.url };
  }
  return { status: "none" };
}

export async function getSandboxStatus(
  sessionId: string,
): Promise<SandboxStatus> {
  return (await getPreviewBackend(sessionId)).getSandboxStatus(sessionId);
}

export async function getAppServerStatus(
  sessionId: string,
): Promise<AppServerStatus> {
  return (await getPreviewBackend(sessionId)).getAppServerStatus(sessionId);
}

export async function getPreviewUrlStatus(
  sessionId: string,
): Promise<PreviewUrlStatus> {
  return previewUrlFromAppServer(await getAppServerStatus(sessionId));
}

/** Read-only snapshot of all three layers. Never starts anything. */
export async function getAllStatus(sessionId: string): Promise<AllStatus> {
  const backend = await getPreviewBackend(sessionId);
  const [sandbox, appServer] = await Promise.all([
    backend.getSandboxStatus(sessionId),
    backend.getAppServerStatus(sessionId),
  ]);
  return {
    sandbox,
    appServer,
    previewUrl: previewUrlFromAppServer(appServer),
  };
}

/**
 * Fast UI status: durable runtime snapshot only (Daytona).
 * Local falls back to live getAllStatus (cheap).
 * When not ready / URL stale, kicks background soft-observe for the next poll.
 */
export async function peekAllStatus(sessionId: string): Promise<AllStatus> {
  const session = await getSession(sessionId);
  if ((session?.sandboxMode ?? "local") !== "daytona") {
    return getAllStatus(sessionId);
  }

  const { peekRuntimeAllStatus, refreshRuntimeInBackground } = await import(
    "./daytona/runtime-reconciler"
  );
  const { getRuntimeSnapshot } = await import("./daytona/runtime-store");
  const { hasFreshPreviewEmbed } = await import("./daytona/runtime-state");

  const all = await peekRuntimeAllStatus(sessionId);
  const snapshot = await getRuntimeSnapshot(sessionId);

  if (all.appServer.status !== "ready" || !hasFreshPreviewEmbed(snapshot)) {
    refreshRuntimeInBackground(sessionId);
  }

  return all;
}

/**
 * Enter/re-enter session: startPreview if needed, return status immediately.
 * Does not await Daytona observe — uses peekAllStatus.
 */
export async function warmPreview(sessionId: string): Promise<AllStatus> {
  startPreview(sessionId);
  return peekAllStatus(sessionId);
}

/**
 * Check app server health (HTTP + buildError).
 * Does not start sandbox or app server.
 */
export async function checkAppServer(
  sessionId: string,
): Promise<AppServerCheck> {
  return (await getPreviewBackend(sessionId)).checkAppServer(sessionId);
}

export async function getBuildError(
  sessionId: string,
): Promise<string | null> {
  return (await getPreviewBackend(sessionId)).getBuildError(sessionId);
}

/** Background: sandbox → app server → preview URL. Call at agent turn start. */
export function startPreview(sessionId: string): void {
  void getPreviewBackend(sessionId).then((backend) => {
    backend.startPreview(sessionId);
  });
}

export async function startAppServer(
  sessionId: string,
): Promise<AppServerStatus> {
  return (await getPreviewBackend(sessionId)).startAppServer(sessionId);
}

export async function restartAppServer(
  sessionId: string,
): Promise<AppServerStatus> {
  return (await getPreviewBackend(sessionId)).restartAppServer(sessionId);
}

export async function stopAppServer(sessionId: string): Promise<void> {
  await (await getPreviewBackend(sessionId)).stopAppServer(sessionId);
}

export async function deleteSandbox(sessionId: string): Promise<void> {
  await (await getPreviewBackend(sessionId)).deleteSandbox(sessionId);
}

export async function hasNodeModules(sessionId: string): Promise<boolean> {
  return (await getPreviewBackend(sessionId)).hasNodeModules(sessionId);
}

export function isTempFailure(check: AppServerCheck): boolean {
  return isLocalTempFailure(check);
}

export { createPreviewBackend, getPreviewBackend };
export type { PreviewBackend } from "./preview-backend";
export type {
  AllStatus,
  AppServerCheck,
  AppServerStatus,
  PreviewUrlStatus,
  SandboxStatus,
} from "./preview-types";
