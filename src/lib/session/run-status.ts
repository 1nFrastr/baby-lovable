import { getRun } from "workflow/api";

import type { Session } from "./types";
import { isActiveRunStatus } from "./types";

const PENDING_START_TIMEOUT_MS = 60_000;

function pendingLeaseExpired(session: Session): boolean {
  if (!session.activeTurnStartedAt) {
    return false;
  }
  return (
    Date.now() - Date.parse(session.activeTurnStartedAt) >
    PENDING_START_TIMEOUT_MS
  );
}

/**
 * Repair lifecycle only through the authoritative session turn token.
 *
 * A transient Workflow API failure never unlocks the composer. Terminal
 * runtime state can seal the matching turn, but cannot mutate a newer turn.
 */
export async function resolveSessionRunState(
  session: Session,
): Promise<Session> {
  if (!isActiveRunStatus(session.runStatus)) {
    return session;
  }

  // Compatibility for rows created before active turn fencing existed.
  if (!session.activeTurnId) {
    if (!session.lastRunId) {
      return session;
    }
    try {
      const run = await getRun(session.lastRunId);
      const liveStatus = await run.status;
      if (liveStatus === "pending" || liveStatus === "running") {
        return session;
      }
      const { updateSession } = await import("./store");
      return updateSession(session.id, {
        runStatus:
          liveStatus === "cancelled"
            ? "cancelled"
            : liveStatus === "completed"
              ? "completed"
              : "failed",
        lastRunId: null,
      });
    } catch {
      return session;
    }
  }

  if (!session.lastRunId) {
    if (
      session.runStatus === "pending" &&
      pendingLeaseExpired(session)
    ) {
      const { failSessionTurn } = await import("./turn-store");
      const failed = await failSessionTurn(
        session.id,
        session.activeTurnId,
      );
      return failed.session ?? session;
    }
    return session;
  }

  try {
    const run = await getRun(session.lastRunId);
    const liveStatus = await run.status;
    if (liveStatus === "pending" || liveStatus === "running") {
      return session;
    }

    if (liveStatus === "cancelled") {
      const { finalizeSessionTurnCancellation } = await import(
        "./turn-store"
      );
      const cancelled = await finalizeSessionTurnCancellation(
        session.id,
        session.activeTurnId,
        null,
        { userId: session.userId },
      );
      return cancelled.session ?? session;
    }

    // A completed runtime whose workflow finalization did not commit its
    // authoritative snapshot is not a successful chat turn.
    const { failSessionTurn } = await import("./turn-store");
    const failed = await failSessionTurn(
      session.id,
      session.activeTurnId,
    );
    return failed.session ?? session;
  } catch (error) {
    console.warn(
      `[run-status] workflow lookup unavailable; keeping turn locked session=${session.id}:`,
      error instanceof Error ? error.message : error,
    );
    return session;
  }
}
