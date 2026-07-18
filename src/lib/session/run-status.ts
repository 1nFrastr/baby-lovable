import { getRun } from "workflow/api";

import type { Session, SessionRunStatus } from "./types";
import { isActiveRunStatus } from "./types";
import { updateSession } from "./store";

const TERMINAL_STATUSES = new Set<SessionRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Reconcile persisted `runStatus` with the Workflow DevKit runtime so page
 * refresh sees an accurate in-flight vs finished state.
 *
 * Persistence failures must not 500 GET /session — return an in-memory
 * reconciled view and best-effort write.
 */
export async function resolveSessionRunState(
  session: Session,
): Promise<Session> {
  if (!session.lastRunId || !isActiveRunStatus(session.runStatus)) {
    return session;
  }

  let patch: {
    runStatus: SessionRunStatus;
    lastRunId?: string | null;
  };

  try {
    const run = await getRun(session.lastRunId);
    const liveStatus = await run.status;

    if (liveStatus === session.runStatus) {
      return session;
    }

    patch = { runStatus: liveStatus };
    if (TERMINAL_STATUSES.has(liveStatus)) {
      patch.lastRunId = null;
    }
  } catch {
    // Missing / unreachable run (common after local workflow restart).
    patch = { runStatus: "idle", lastRunId: null };
  }

  try {
    return await updateSession(session.id, patch);
  } catch (error) {
    console.warn(
      `[run-status] reconcile persist failed session=${session.id}:`,
      error instanceof Error ? error.message : error,
    );
    const fallback: Session = {
      ...session,
      runStatus: patch.runStatus,
      updatedAt: new Date().toISOString(),
    };
    if (patch.lastRunId === null) {
      delete fallback.lastRunId;
    } else if (patch.lastRunId !== undefined) {
      fallback.lastRunId = patch.lastRunId;
    }
    return fallback;
  }
}
