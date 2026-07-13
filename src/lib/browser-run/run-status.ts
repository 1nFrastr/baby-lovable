import type { UserId } from "@/lib/session/types";

import type { AppTestAction, AppTestReport } from "./types";

export type AppTestRunStatus = "idle" | "running" | "done" | "error";

export interface AppTestLatestStatus {
  status: AppTestRunStatus;
  runId?: string;
  liveViewUrl?: string;
  ok?: boolean;
  summary?: string;
  artifactDir?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  usedScriptedActions?: boolean;
}

/** Shared across Vercel isolates via Daytona sandbox FS (app test requires daytona). */
const REMOTE_STATUS_PATH = ".runtime/app-test-latest-status.json";

const runningBySession = new Map<string, Promise<AppTestReport>>();
const runLocks = new Set<string>();
/** Same-process fast path (local next dev / sticky instance). */
const latestStatusBySession = new Map<string, AppTestLatestStatus>();

function statusCacheKey(sessionId: string, userId: UserId = null): string {
  return `${userId ?? "_"}:${sessionId}`;
}

async function writeRemoteStatus(
  sessionId: string,
  status: AppTestLatestStatus,
): Promise<void> {
  try {
    const { getSession } = await import("@/lib/session/store");
    const session = await getSession(sessionId);
    if (!session || session.sandboxMode !== "daytona") {
      return;
    }
    const { getOrCreateDaytonaSandbox } = await import(
      "@/lib/sandbox/daytona/sandbox-manager"
    );
    const sandbox = await getOrCreateDaytonaSandbox(sessionId);
    try {
      await sandbox.fs.createFolder(".runtime");
    } catch {
      // exists
    }
    await sandbox.fs.writeTextFile(
      REMOTE_STATUS_PATH,
      `${JSON.stringify(status)}\n`,
    );
  } catch (error) {
    // Best effort — memory still helps same-process polls.
    console.warn(
      `[app-test] failed to write Daytona status for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function readRemoteStatus(
  sessionId: string,
): Promise<AppTestLatestStatus | null> {
  try {
    const { getSession } = await import("@/lib/session/store");
    const session = await getSession(sessionId);
    if (!session || session.sandboxMode !== "daytona") {
      return null;
    }
    const { getOrCreateDaytonaSandbox } = await import(
      "@/lib/sandbox/daytona/sandbox-manager"
    );
    const sandbox = await getOrCreateDaytonaSandbox(sessionId);
    const raw = await sandbox.fs.readTextFile(REMOTE_STATUS_PATH);
    const parsed = JSON.parse(raw) as AppTestLatestStatus;
    if (!parsed || typeof parsed !== "object" || !parsed.status) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Prefer Daytona FS (cross-isolate) over in-memory cache.
 * Never short-circuit on a stale "running" cache — that hid liveViewUrl
 * updates written by the workflow step on another Vercel instance.
 */
function mergeAppTestStatus(
  cached: AppTestLatestStatus | undefined,
  remote: AppTestLatestStatus | null,
): AppTestLatestStatus {
  if (!remote && !cached) {
    return { status: "idle" };
  }
  if (!remote) {
    return cached!;
  }
  if (!cached) {
    return remote;
  }

  // Same-process finish beat a lagging remote write.
  if (
    (cached.status === "done" || cached.status === "error") &&
    remote.status === "running" &&
    cached.runId &&
    cached.runId === remote.runId
  ) {
    return {
      ...remote,
      ...cached,
      liveViewUrl: cached.liveViewUrl ?? remote.liveViewUrl,
    };
  }

  return {
    ...cached,
    ...remote,
    liveViewUrl: remote.liveViewUrl ?? cached.liveViewUrl,
  };
}

export async function readLatestAppTestStatus(
  sessionId: string,
  userId: UserId = null,
): Promise<AppTestLatestStatus> {
  const key = statusCacheKey(sessionId, userId);
  const cached = latestStatusBySession.get(key);

  // Always refresh Daytona FS while polling — a Vercel API isolate must not
  // stick on a stale in-memory "running" without liveViewUrl (or a stale
  // "done" after a new run starts on another isolate).
  const remote = await readRemoteStatus(sessionId);
  const merged = mergeAppTestStatus(cached, remote);
  latestStatusBySession.set(key, merged);
  return merged;
}

/**
 * Publish Live View / run status for the Web UI poller.
 * Memory (same process) + Daytona FS (serverless / cross-instance).
 */
export async function writeLatestAppTestStatus(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: UserId = null,
): Promise<void> {
  latestStatusBySession.set(statusCacheKey(sessionId, userId), status);
  await writeRemoteStatus(sessionId, status);
}

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
