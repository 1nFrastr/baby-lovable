import { NextResponse } from "next/server";

import { integrationErrorResponse } from "@/app/api/integrations/_responses";
import { getSessionSupabaseAuth, patchSessionSupabaseAuth } from "@/lib/integrations/supabase-admin";
import { requireSessionAuth } from "@/lib/session/auth-context";

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const auth = await requireSessionAuth(request);
    const { sessionId } = await params;
    return NextResponse.json(await getSessionSupabaseAuth(sessionId, auth.userId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin !== new URL(request.url).origin || (site !== null && site !== "same-origin" && site !== "none")) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const auth = await requireSessionAuth(request);
    const { sessionId } = await params;
    const body: unknown = await request.json().catch(() => null);
    return NextResponse.json(await patchSessionSupabaseAuth(sessionId, auth.userId, body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
