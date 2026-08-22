import {
  isActiveRunStatus,
  isLiveChatTurn,
  isTerminalRunStatus,
  type SessionRunStatus,
} from "@/lib/session/types";

export interface ComposerLockState {
  stopping: boolean;
  awaitingRunStart: boolean;
  chatStatus: string;
  runStatus: SessionRunStatus;
  /**
   * True after a mid-run page refresh: server run is still active, but this
   * mount never saw useChat submit/stream (SSE was lost). Distinct from
   * auto-finish where transport went ready while Realtime still says running.
   */
  resumeActiveRun?: boolean;
}

/**
 * Whether the user may send another message.
 *
 * Auto-finish follows the chat transport / early terminal runStatus
 * (`isLiveChatTurn`). Mid-run refresh uses `resumeActiveRun`. Cancel
 * confirmation is a separate `stopping` latch.
 */
export function isComposerLocked(state: ComposerLockState): boolean {
  return (
    state.stopping ||
    state.awaitingRunStart ||
    Boolean(state.resumeActiveRun) ||
    isLiveChatTurn(state.chatStatus, state.runStatus)
  );
}

/**
 * Stop control is only for an in-flight generation the user can cancel.
 * Do not show it for awaiting-send gaps or post-turn HTTP drain after
 * the server already reported terminal.
 *
 * After a mid-run refresh, transport is `ready` but the server run may still
 * be active — still offer Stop via `resumeActiveRun`.
 */
export function shouldShowStopControl(state: {
  stopping: boolean;
  chatStatus: string;
  runStatus: SessionRunStatus;
  resumeActiveRun?: boolean;
}): boolean {
  if (state.stopping) {
    return false;
  }
  if (isTerminalRunStatus(state.runStatus)) {
    return false;
  }
  if (state.resumeActiveRun && isActiveRunStatus(state.runStatus)) {
    return true;
  }
  return (
    state.chatStatus === "submitted" || state.chatStatus === "streaming"
  );
}

/**
 * Release the stop lock only after cancel is confirmed.
 *
 * - `cancelled` is the success signal the user asked to wait for.
 * - `completed` / `failed` also release when we had already observed an
 *   active run (the turn ended on its own while Stop was in flight).
 * - A stale terminal status from the previous turn must not unlock a stop
 *   that happened during the optimistic send gap.
 */
export function shouldReleaseComposerAfterStop(options: {
  cancelSucceeded: boolean;
  runStatus: SessionRunStatus;
  observedActiveRun: boolean;
}): boolean {
  if (!options.cancelSucceeded) {
    return false;
  }
  if (options.runStatus === "cancelled") {
    return true;
  }
  return (
    options.observedActiveRun &&
    (options.runStatus === "completed" || options.runStatus === "failed")
  );
}
