import { NextResponse } from "next/server";

import { getAllStatus } from "@/lib/sandbox/preview";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { readDraft } from "@/lib/session/draft-store";
import { resolveSessionRunState } from "@/lib/session/run-status";
import { getSession } from "@/lib/session/store";
import { isActiveRunStatus } from "@/lib/session/types";

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
    const all = await getAllStatus(sessionId);
    const rawDraft =
      isActiveRunStatus(resolved.runStatus) && resolved.lastRunId
        ? await readDraft(sessionId, auth.userId)
        : null;
    const draft =
      rawDraft && rawDraft.runId === resolved.lastRunId ? rawDraft : null;

    return NextResponse.json({
      session: resolved,
      draft,
      sandbox: all.sandbox,
      appServer: all.appServer,
      previewUrl: all.previewUrl,
      preview: all.appServer,
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
