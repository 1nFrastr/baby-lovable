import { NextResponse } from "next/server";

import {
  GithubSyncError,
  listAvailableGithubRepositories,
} from "@/lib/git/github-sync";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

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
      throw new GithubSyncError(
        "GitHub Sync is only available for Daytona sessions",
      );
    }

    const repositories = await listAvailableGithubRepositories(
      auth.userId,
      auth.githubIdentity ?? null,
    );
    return NextResponse.json(
      { repositories },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof GithubSyncError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    const message =
      error instanceof Error ? error.message : "Failed to list GitHub repositories";
    console.error(`[github-sync/repositories] GET session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
