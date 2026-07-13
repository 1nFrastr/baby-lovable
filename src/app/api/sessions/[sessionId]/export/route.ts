import { NextResponse } from "next/server";

import { exportWorkspaceArchive } from "@/lib/sandbox/export-archive";
import { NotImplementedError } from "@/lib/sandbox/types";
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

    const archive = await exportWorkspaceArchive(sessionId);
    const disposition = `attachment; filename="${archive.filename}"`;

    return new NextResponse(Buffer.from(archive.bytes), {
      status: 200,
      headers: {
        "Content-Type": archive.contentType,
        "Content-Disposition": disposition,
        "Content-Length": String(archive.bytes.byteLength),
        "X-Export-Source": archive.source,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof NotImplementedError) {
      return NextResponse.json({ error: error.message }, { status: 501 });
    }
    const message = error instanceof Error ? error.message : "Export failed";
    console.error(`[export] session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
