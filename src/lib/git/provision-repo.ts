import { randomUUID } from "node:crypto";

import { sanitizeJsonbText } from "@/lib/json/sanitize-jsonb";
import { getFreestyleAdapter } from "./freestyle-client";
import { isFreestyleConfigured } from "./freestyle-config";
import {
  ensureGitRepository,
  updateGitRepositoryWithRetry,
} from "./repository-store";
import { seedEmptyFreestyleRepo } from "./seed-remote";
import type { SessionGitRepository } from "./types";

/**
 * Ensure Freestyle private repo + identity exist for a Daytona session.
 * Idempotent; safe to call from session create after() and reconciler.
 */
export async function ensureFreestyleRepository(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  if (!isFreestyleConfigured()) {
    throw new Error("FREESTYLE_API_KEY is required for Daytona Git provisioning");
  }

  const current = await ensureGitRepository(sessionId, userId);
  if (current.repoId && current.identityId && current.remoteUrl) {
    if (current.provisionStatus === "error") {
      return updateGitRepositoryWithRetry(
        sessionId,
        () => ({
          provisionStatus: "preparing",
          provisionError: null,
        }),
        userId,
      );
    }
    return current;
  }

  await updateGitRepositoryWithRetry(
    sessionId,
    (repo) => {
      if (repo.repoId && repo.identityId && repo.remoteUrl) {
        return null;
      }
      return {
        provisionStatus: "preparing",
        provisionError: null,
      };
    },
    userId,
  );

  const adapter = getFreestyleAdapter();
  const handle = await adapter.createPrivateRepo({
    name: `baby-lovable-${sessionId}`,
    defaultBranch: "main",
  });

  const bound = await updateGitRepositoryWithRetry(
    sessionId,
    (repo) => {
      // Another worker may have won the create race — keep existing binding.
      if (repo.repoId && repo.identityId && repo.remoteUrl) {
        return null;
      }
      return {
        repoId: handle.repoId,
        remoteUrl: handle.remoteUrl,
        identityId: handle.identityId,
        defaultBranch: "main",
        provisionStatus: "preparing",
        provisionError: null,
      };
    },
    userId,
  );

  // Seed `main` immediately via Commits API so Daytona git never talks to an
  // empty Freestyle remote (`malformed zero-id ref`). Do not store
  // remoteHeadSha here — that would make first-sandbox create block on pull
  // and delay preview; snapshot already has the starter tree. Seed failure
  // fails provision: writes must not proceed against an empty remote.
  if (!bound.repoId) {
    throw new Error("Freestyle repository binding incomplete after create");
  }
  await seedEmptyFreestyleRepo(bound.repoId);
  return bound;
}

export async function markRepositoryReady(
  sessionId: string,
  remoteHeadSha: string | null,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  return updateGitRepositoryWithRetry(
    sessionId,
    () => ({
      provisionStatus: "ready",
      provisionError: null,
      remoteHeadSha,
      syncStatus: "idle",
      syncError: null,
      unrecoverable: false,
    }),
    userId,
  );
}

export async function markRepositoryProvisionError(
  sessionId: string,
  error: string,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  return updateGitRepositoryWithRetry(
    sessionId,
    () => ({
      provisionStatus: "error",
      provisionError: redactSecrets(error),
    }),
    userId,
  );
}

export async function markRepositoryUnrecoverable(
  sessionId: string,
  reason: string,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  return updateGitRepositoryWithRetry(
    sessionId,
    () => ({
      provisionStatus: "error",
      unrecoverable: true,
      provisionError: redactSecrets(reason),
    }),
    userId,
  );
}

/** Strip accidental token/password material from persisted errors. */
export function redactSecrets(message: string): string {
  return sanitizeJsonbText(
    message
      .replace(/x-access-token:[^\s@/]+/gi, "x-access-token:[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/fake-token-[^\s]+/gi, "[REDACTED]")
      .replace(/ghp_[A-Za-z0-9]+/g, "[REDACTED]")
      .slice(0, 500),
  );
}

export function newLocalCheckpointRunId(): string {
  return `cli_${randomUUID()}`;
}
