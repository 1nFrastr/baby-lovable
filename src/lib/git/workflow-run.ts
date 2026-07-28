import { randomUUID } from "node:crypto";

import { getRun } from "workflow/api";

const CLAIM_PREFIX = "claiming:";
/** Claim tokens act as a short mutex while `start()` / inline fallback is in flight. */
const CLAIM_TTL_MS = 180_000;
const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);

export function isClaimToken(workflowRunId: string | null | undefined): boolean {
  return Boolean(workflowRunId?.startsWith(CLAIM_PREFIX));
}

export function newClaimToken(): string {
  return `${CLAIM_PREFIX}${Date.now()}:${randomUUID()}`;
}

export function isActiveClaimToken(
  workflowRunId: string | null | undefined,
): boolean {
  if (!isClaimToken(workflowRunId)) {
    return false;
  }
  const parts = workflowRunId!.split(":");
  const ts = Number(parts[1]);
  return Number.isFinite(ts) && Date.now() - ts < CLAIM_TTL_MS;
}

/**
 * True when a Workflow DevKit run is still in-flight (or a kick claim is held).
 * Missing / unreachable runs count as dead so waiters can self-heal.
 */
export async function isWorkflowRunActive(
  workflowRunId: string | null | undefined,
): Promise<boolean> {
  if (!workflowRunId) {
    return false;
  }
  if (isClaimToken(workflowRunId)) {
    return isActiveClaimToken(workflowRunId);
  }
  try {
    const run = await getRun(workflowRunId);
    const status = await run.status;
    return ACTIVE_RUN_STATUSES.has(status);
  } catch {
    return false;
  }
}
