import { NextResponse } from "next/server";

import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { resolveSessionRunState } from "@/lib/session/run-status";
import { getSession } from "@/lib/session/store";

/**
 * Authoritative session conversation + turn lifecycle.
 * Preview status lives on GET/POST `/preview` (PreviewPanel) — never block chat load on Daytona observe.
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

    const resolved = await resolveSessionRunState(session);

    return NextResponse.json({
      session: resolved,
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
