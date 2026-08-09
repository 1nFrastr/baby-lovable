import { NextResponse } from "next/server";

import {
  createAndLinkGithubRepo,
  getGithubSyncStatus,
  GithubSyncError,
  linkGithubRepo,
  unlinkGithubRepo,
} from "@/lib/git/github-sync";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

function assertDaytonaSession(sandboxMode: string | undefined): void {
  if (sandboxMode !== "daytona") {
    throw new GithubSyncError(
      "GitHub Sync is only available for Daytona sessions",
      400,
    );
  }
}

function githubSyncErrorResponse(error: GithubSyncError) {
  return NextResponse.json(
    {
      error: error.message,
      ...(error.authUrl ? { authUrl: error.authUrl } : {}),
    },
    { status: error.status },
  );
}

/**
 * Freestyle ↔ GitHub Sync for a Daytona session.
 *
 * POST modes:
 * - `{ mode: "create_and_link", repoName? }` — OAuth (if needed) → create empty repo → enable sync
 * - `{ githubRepoName }` — link an existing owner/repo (advanced)
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
    assertDaytonaSession(session.sandboxMode);

    const url = new URL(request.url);
    const reconcile = url.searchParams.get("reconcile") === "1";
    const status = await getGithubSyncStatus(sessionId, auth.userId, {
      reconcile,
      requestOrigin: url.origin,
    });

    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof GithubSyncError) {
      return githubSyncErrorResponse(error);
    }
    const message =
      error instanceof Error ? error.message : "Failed to read GitHub Sync";
    console.error(`[github-sync] GET session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
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
    assertDaytonaSession(session.sandboxMode);

    const body = (await request.json().catch(() => null)) as {
      mode?: unknown;
      githubRepoName?: unknown;
      repoName?: unknown;
    } | null;

    const mode =
      typeof body?.mode === "string" ? body.mode : "link_existing";
    const requestOrigin = new URL(request.url).origin;

    if (mode === "create_and_link") {
      const repoName =
        typeof body?.repoName === "string" ? body.repoName : undefined;
      const repo = await createAndLinkGithubRepo(sessionId, auth.userId, {
        repoName,
        requestOrigin,
        returnTo: `/sessions/${sessionId}`,
      });
      return NextResponse.json(
        {
          linked: true,
          githubRepoName: repo.githubRepoName,
          githubSyncStatus: repo.githubSyncStatus,
          githubSyncError: repo.githubSyncError,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const githubRepoName =
      typeof body?.githubRepoName === "string" ? body.githubRepoName : "";
    if (!githubRepoName.trim()) {
      return NextResponse.json(
        {
          error:
            "githubRepoName is required (owner/repo), or use mode: create_and_link",
        },
        { status: 400 },
      );
    }

    const repo = await linkGithubRepo(sessionId, githubRepoName, auth.userId);
    return NextResponse.json(
      {
        linked: true,
        githubRepoName: repo.githubRepoName,
        githubSyncStatus: repo.githubSyncStatus,
        githubSyncError: repo.githubSyncError,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof GithubSyncError) {
      return githubSyncErrorResponse(error);
    }
    const message =
      error instanceof Error ? error.message : "Failed to link GitHub Sync";
    console.error(`[github-sync] POST session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
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
    assertDaytonaSession(session.sandboxMode);

    const repo = await unlinkGithubRepo(sessionId, auth.userId);
    return NextResponse.json(
      {
        linked: false,
        githubRepoName: repo.githubRepoName,
        githubSyncStatus: repo.githubSyncStatus,
        githubSyncError: repo.githubSyncError,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof GithubSyncError) {
      return githubSyncErrorResponse(error);
    }
    const message =
      error instanceof Error ? error.message : "Failed to unlink GitHub Sync";
    console.error(`[github-sync] DELETE session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
