import { NextResponse } from "next/server";

import { resolvePreviewStatus } from "@/lib/sandbox/dev-server";
import { getSession } from "@/lib/session/store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const preview = await resolvePreviewStatus(sessionId);

  return NextResponse.json({ session, preview });
}
