import { NextResponse } from "next/server";

import { integrationErrorResponse } from "@/app/api/integrations/_responses";
import { listPublishTeams } from "@/lib/integrations/vercel-publish";
import { requireSessionAuth } from "@/lib/session/auth-context";
import { getSessionMeta } from "@/lib/session/store";

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const auth = await requireSessionAuth(request);
    const { sessionId } = await params;
    if (!await getSessionMeta(sessionId, auth)) return NextResponse.json({ error: "App not found." }, { status: 404 });
    const teams = await listPublishTeams(sessionId, auth.userId);
    return NextResponse.json({ teams: teams.map(({ id, slug, name }) => ({ id, slug, name })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
