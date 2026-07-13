import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getSessionRoot } from "@/lib/sandbox/paths";
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

const runningBySession = new Map<string, Promise<AppTestReport>>();
const runLocks = new Set<string>();

export function resolveLatestStatusPath(
  sessionId: string,
  userId: UserId = null,
): string {
  return path.join(
    getSessionRoot(sessionId, userId),
    "app-tests",
    "latest-status.json",
  );
}

export async function readLatestAppTestStatus(
  sessionId: string,
  userId: UserId = null,
): Promise<AppTestLatestStatus> {
  const filePath = resolveLatestStatusPath(sessionId, userId);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AppTestLatestStatus;
    if (!parsed || typeof parsed !== "object" || !parsed.status) {
      return { status: "idle" };
    }
    return parsed;
  } catch {
    return { status: "idle" };
  }
}

export async function writeLatestAppTestStatus(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: UserId = null,
): Promise<void> {
  const filePath = resolveLatestStatusPath(sessionId, userId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
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

  // Don't await — caller returns immediately; status file is updated by runner.
  void promise.catch(() => {
    // Errors are persisted via writeLatestAppTestStatus in runAppTest.
  });

  return { started: true };
}
