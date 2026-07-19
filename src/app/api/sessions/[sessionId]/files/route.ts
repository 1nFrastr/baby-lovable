import { NextResponse } from "next/server";

import { getProjectSandbox } from "@/lib/sandbox/factory";
import {
  assertExplorerListPath,
  buildExplorerTree,
} from "@/lib/sandbox/workspace-explorer";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

/**
 * Return the full workspace file-tree meta in one response.
 * Content is loaded separately via /files/content (read-only, truncated).
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

    const blocked = assertExplorerListPath(".");
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 403 });
    }

    const sandbox = await getProjectSandbox(
      sessionId,
      session.sandboxMode,
      auth.userId,
    );
    const result = await buildExplorerTree(sandbox.fs);

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const message =
      error instanceof Error ? error.message : "Failed to list files";
    console.error(`[files] session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
