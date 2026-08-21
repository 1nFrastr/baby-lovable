import {
  isLiveChatTurn,
  type SessionRunStatus,
} from "@/lib/session/types";

export interface ComposerLockState {
  stopping: boolean;
  awaitingRunStart: boolean;
  chatStatus: string;
  runStatus: SessionRunStatus;
}

/**
 * Composer must stay locked for the whole in-flight turn and the entire
 * cancel round-trip. Unlocking on cancel HTTP success alone is not enough —
 * a leftover `running` projection would let the user send into a still-live
 * workflow.
 */
export function isComposerLocked(state: ComposerLockState): boolean {
  return (
    state.stopping ||
    state.awaitingRunStart ||
    isLiveChatTurn(state.chatStatus, state.runStatus)
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
