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
 */
export async function resolveSessionRunState(
  session: Session,
): Promise<Session> {
  if (!session.lastRunId || !isActiveRunStatus(session.runStatus)) {
    return session;
  }

  try {
    const run = await getRun(session.lastRunId);
    const liveStatus = await run.status;

    if (liveStatus === session.runStatus) {
      return session;
    }

    const patch: {
      runStatus: SessionRunStatus;
      lastRunId?: string | null;
    } = {
      runStatus: liveStatus,
    };

    if (TERMINAL_STATUSES.has(liveStatus)) {
      patch.lastRunId = null;
    }

    return updateSession(session.id, patch);
  } catch {
    return updateSession(session.id, {
      runStatus: "idle",
      lastRunId: null,
    });
  }
}
