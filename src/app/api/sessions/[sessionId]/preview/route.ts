import { NextResponse } from "next/server";

import {
  ensureDevServer,
  getPreviewStatus,
  hasNodeModules,
  restartDevServer,
  resolvePreviewStatus,
  stopDevServer,
} from "@/lib/sandbox/dev-server";
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
  return NextResponse.json({ preview });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: "start" | "restart";
  };

  const hasDeps = await hasNodeModules(sessionId);
  if (!hasDeps) {
    return NextResponse.json({
      preview: { status: "needs_install" as const },
    });
  }

  const preview =
    body.action === "restart"
      ? await restartDevServer(sessionId)
      : await ensureDevServer(sessionId);

  return NextResponse.json({ preview });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  await stopDevServer(sessionId);
  return NextResponse.json({ preview: getPreviewStatus(sessionId) });
}
