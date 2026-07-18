import { NextResponse } from "next/server";

import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import {
  ensureRuntimeProjection,
  getRuntimeTransport,
} from "@/lib/session/runtime-projection-store";
import { getSession } from "@/lib/session/store";

async function resolveAuth(request: Request) {
  try {
    return await requireSessionAuth(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }
}

/** Sole UI read snapshot for run / preview / appTest. Reads durable projection only. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const auth = await resolveAuth(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const session = await getSession(sessionId, auth);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const projection = await ensureRuntimeProjection(
      sessionId,
      session.userId,
    );

    return NextResponse.json({
      projection,
      transport: getRuntimeTransport(),
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
