import { NextResponse } from "next/server";

import { listGitSyncTasks } from "@/lib/git/sync-task-store";
import type {
  SessionGitSyncTask,
  VersionHistoryItem,
} from "@/lib/git/types";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

function toVersionItem(task: SessionGitSyncTask): VersionHistoryItem {
  const sha = task.remoteSha ?? task.localCommitSha;
  return {
    runId: task.runId,
    status: task.status,
    outcome: task.outcome,
    commitMessage: task.commitMessage,
    shortSha: sha ? sha.slice(0, 7) : null,
    error: task.lastError,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * List per-turn Freestyle checkpoints for a session (newest first).
 * Read-only — revert / restore is not exposed yet.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  let auth;
  try {
    auth = await requireSessionAuth(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }

  try {
    const session = await getSession(sessionId, auth);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.sandboxMode !== "daytona") {
      return NextResponse.json(
        { versions: [] as VersionHistoryItem[], available: false },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const tasks = await listGitSyncTasks(sessionId, auth.userId);
    const versions = [...tasks]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toVersionItem);

    return NextResponse.json(
      { versions, available: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const message =
      error instanceof Error ? error.message : "Failed to list versions";
    console.error(`[versions] session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
