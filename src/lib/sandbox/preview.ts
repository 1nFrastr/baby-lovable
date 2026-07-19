/**
 * Preview API — one place for callers.
 *
 * Three layers: sandbox → appServer → previewUrl
 *
 * Read:  getSandboxStatus / getAppServerStatus / getPreviewUrlStatus / getAllStatus
 *        peekAllStatus (durable snapshot, no remote probe) / checkAppServer / getBuildError
 * Write: kickRuntimeDesired (non-blocking prelude) / startPreview / startAppServer /
 *        restartAppServer / stopAppServer / deleteSandbox
 *
 * Mode (local | daytona) is chosen once via createPreviewBackend / getPreviewBackend.
 *
 * Warm model (Daytona):
 *   session create / first connect → sandbox-ready, wait:false
 *   first turn / preview open     → preview-ready, wait:false
 *   AI loop never awaits warm; after() only keeps the isolate alive for reconcile.
 */

import type { DaytonaDesiredState } from "./daytona/runtime-state";
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

export type RuntimeWarmDesired = Extract<
  DaytonaDesiredState,
  "sandbox-ready" | "preview-ready"
>;

/**
 * Non-blocking prelude: submit desired via reconciler and return immediately.
 * Does not await VM create / install / next — AI loop must not wait on this.
 */
export async function kickRuntimeDesired(
  sessionId: string,
  desired: RuntimeWarmDesired,
): Promise<AllStatus> {
  const session = await getSession(sessionId);
  if ((session?.sandboxMode ?? "local") === "daytona") {
    const { ensureDesiredState } = await import("./daytona/runtime-reconciler");
    await ensureDesiredState(sessionId, desired, { wait: false });
  } else if (desired === "preview-ready") {
    startPreview(sessionId);
  }
  return peekAllStatus(sessionId);
}

/**
 * Await reconciler convergence. Call from Next.js `after()` only — keeps the
 * serverless isolate alive so wait:false background work is not frozen mid-create.
 */
export async function awaitRuntimeDesired(
  sessionId: string,
  desired: RuntimeWarmDesired,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.sandboxMode !== "daytona") {
    if (desired === "preview-ready") {
      startPreview(sessionId);
    }
    return;
  }
  const { ensureDesiredState } = await import("./daytona/runtime-reconciler");
  await ensureDesiredState(sessionId, desired, { wait: true });
}

/**
 * @deprecated Prefer {@link kickRuntimeDesired}("preview-ready").
 * Enter/re-enter session: non-blocking preview-ready prelude.
 */
export async function warmPreview(sessionId: string): Promise<AllStatus> {
  return kickRuntimeDesired(sessionId, "preview-ready");
}

/**
 * Check app server health (HTTP readiness).
 * Daytona: does not read compile logs (those are on write/edit peek).
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

/**
 * Cheap post-edit hint: only when app server is already ready, read compile
 * error from logs (no HTTP probe, settle, or retries). Returns null when
 * preview is still warming so bootstrap I/O is not slowed.
 */
export async function peekCompileErrorIfPreviewReady(
  sessionId: string,
): Promise<string | null> {
  const backend = await getPreviewBackend(sessionId);
  const status = await backend.getAppServerStatus(sessionId);
  if (status.status !== "ready") {
    return null;
  }
  return backend.getBuildError(sessionId);
}

export type CheckPreviewProbeResult = {
  status: AppServerCheck["status"];
  url?: string;
  httpStatus?: number;
  buildError: string | null;
  retried: boolean;
  restarted: boolean;
  ok: boolean;
};

function toCheckPreviewResult(
  report: AppServerCheck,
  retried: boolean,
  restarted: boolean,
): CheckPreviewProbeResult {
  return {
    status: report.status,
    url: report.url,
    httpStatus: report.httpStatus,
    buildError: report.buildError,
    retried,
    restarted,
    ok:
      report.buildError === null &&
      report.status === "ready" &&
      (report.httpStatus === undefined || report.httpStatus < 500),
  };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Orchestrate checkPreview probe: skip settle/warm retries when already ready.
 */
export async function runCheckPreviewProbe(
  sessionId: string,
  options: {
    restart?: boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<CheckPreviewProbeResult> {
  const restart = options.restart ?? false;
  const sleep = options.sleep ?? defaultSleep;
  const t0 = Date.now();
  let checkCalls = 0;

  const timedCheck = async (label: string) => {
    const t = Date.now();
    checkCalls += 1;
    const report = await checkAppServer(sessionId);
    console.warn(
      `[checkPreview] session=${sessionId} ${label} #${checkCalls} ms=${Date.now() - t} status=${report.status} http=${report.httpStatus ?? "n/a"}`,
    );
    return report;
  };

  if (restart) {
    await restartAppServer(sessionId);
    await sleep(3_000);
  }

  let report = await timedCheck("first");
  let retried = false;

  // Fast path: already ready — no HMR settle, no installing/starting loop.
  // Do not bump iframe generation here: same URL + healthy ready is not a new
  // embed state (avoids checkPreview-driven refresh loops).
  if (!restart && report.status === "ready") {
    if (isTempFailure(report)) {
      await sleep(1_500);
      report = await timedCheck("temp-retry");
      retried = true;
    }
    console.warn(
      `[checkPreview] session=${sessionId} done ms=${Date.now() - t0} path=ready-fast checks=${checkCalls}`,
    );
    return toCheckPreviewResult(report, retried, restart);
  }

  // Warm path: brief settle, then poll until ready / attempts exhausted.
  if (!restart) {
    await sleep(1_000);
    report = await timedCheck("after-settle");
  }

  for (
    let attempt = 0;
    attempt < 4 &&
    (report.status === "starting" || report.status === "installing");
    attempt++
  ) {
    await sleep(2_000);
    report = await timedCheck(`warm-poll-${attempt}`);
    retried = true;
  }

  if (!restart && isTempFailure(report)) {
    await sleep(1_500);
    report = await timedCheck("temp-retry");
    retried = true;
  }

  console.warn(
    `[checkPreview] session=${sessionId} done ms=${Date.now() - t0} path=warm status=${report.status} checks=${checkCalls}`,
  );
  // Iframe remount is driven by URL / restart generation / PreviewPanel
  // warm|error→ready detection — not by every successful checkPreview.
  return toCheckPreviewResult(report, retried, restart);
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
