import type { UserId } from "@/lib/session/types";

import { appTestStatusWriteDelayMs } from "./config";
import type {
  AppTestAction,
  AppTestLatestStatus,
  AppTestReport,
  AppTestRunStatus,
} from "./types";

export type { AppTestLatestStatus, AppTestRunStatus };

const runningBySession = new Map<string, Promise<AppTestReport>>();
const runLocks = new Set<string>();

async function writeDurableStatus(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: UserId = null,
): Promise<void> {
  const delayMs = appTestStatusWriteDelayMs();
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  try {
    const { writeAppTestStatusStore } = await import(
      "@/lib/session/app-test-status-store"
    );
    await writeAppTestStatusStore(sessionId, status, userId);
  } catch (error) {
    console.warn(
      `[app-test] failed to write durable status for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function readDurableStatus(
  sessionId: string,
  userId: UserId = null,
): Promise<AppTestLatestStatus | null> {
  try {
    const { readAppTestStatusStore } = await import(
      "@/lib/session/app-test-status-store"
    );
    return await readAppTestStatusStore(sessionId, userId);
  } catch (error) {
    console.warn(
      `[app-test] failed to read durable status for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Read Live View / run status for the Web UI poller.
 * Always durable store only (session file / Supabase) — same path local + Vercel.
 */
export async function readLatestAppTestStatus(
  sessionId: string,
  userId: UserId = null,
): Promise<AppTestLatestStatus> {
  return (await readDurableStatus(sessionId, userId)) ?? { status: "idle" };
}

/**
 * Publish Live View / run status for the Web UI poller.
 * Durable store only so local next dev matches Vercel multi-isolate timing.
 */
export async function writeLatestAppTestStatus(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: UserId = null,
): Promise<void> {
  await writeDurableStatus(sessionId, status, userId);

  try {
    const { appTestFromLatest } = await import(
      "@/lib/session/runtime-projection"
    );
    const { publishRuntimeUpdate } = await import(
      "@/lib/session/runtime-projection-store"
    );
    await publishRuntimeUpdate(
      sessionId,
      { appTest: appTestFromLatest(status) },
      userId,
    );
  } catch {
    // Projection publish is best-effort; durable app-test status is source of truth.
  }
}

/**
 * In-process lock for same-isolate POST/agent overlap only.
 * Not visible across Vercel isolates — UI status must come from durable store.
 */
export function isAppTestRunning(sessionId: string): boolean {
  return runLocks.has(sessionId) || runningBySession.has(sessionId);
}

export function getRunningAppTest(
  sessionId: string,
): Promise<AppTestReport> | undefined {
  return runningBySession.get(sessionId);
}

/** Sync lock so Agent + POST cannot overlap. Returns false if already locked. */
export function acquireAppTestLock(sessionId: string): boolean {
  if (runLocks.has(sessionId)) {
    return false;
  }
  runLocks.add(sessionId);
  return true;
}

export function releaseAppTestLock(sessionId: string): void {
  runLocks.delete(sessionId);
}

/**
 * Track an in-flight run so POST /app-test can reject concurrent starts.
 * Clears the map entry when the promise settles.
 */
export function trackAppTestRun(
  sessionId: string,
  promise: Promise<AppTestReport>,
): Promise<AppTestReport> {
  runningBySession.set(sessionId, promise);
  void promise.finally(() => {
    if (runningBySession.get(sessionId) === promise) {
      runningBySession.delete(sessionId);
    }
  });
  return promise;
}

export function statusFromReport(report: AppTestReport): AppTestLatestStatus {
  return {
    status: report.ok ? "done" : "error",
    runId: report.runId,
    liveViewUrl: report.liveViewUrl,
    ok: report.ok,
    summary: report.summary,
    artifactDir: report.artifactDir,
    finishedAt: new Date().toISOString(),
    error: report.error,
    usedScriptedActions: report.usedScriptedActions,
  };
}

export async function startBackgroundAppTest(options: {
  sessionId: string;
  holdMs?: number;
  actions?: AppTestAction[];
  maxClicks?: number;
}): Promise<
  { started: true } | { error: string; status: number }
> {
  if (isAppTestRunning(options.sessionId)) {
    return {
      error: "An app test is already running for this session",
      status: 409,
    };
  }

  const { runAppTest } = await import("./run-app-test");

  const promise = runAppTest({
    sessionId: options.sessionId,
    holdMs: options.holdMs,
    actions: options.actions,
    maxClicks: options.maxClicks,
  });

  trackAppTestRun(options.sessionId, promise);

  void promise.catch(() => {
    // Errors are published via writeLatestAppTestStatus in runAppTest.
  });

  return { started: true };
}
