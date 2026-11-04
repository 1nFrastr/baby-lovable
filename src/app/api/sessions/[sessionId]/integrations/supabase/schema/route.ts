import { NextResponse } from "next/server";

import { integrationErrorResponse } from "@/app/api/integrations/_responses";
import { getSessionSupabaseSchema } from "@/lib/integrations/supabase-admin";
import { requireSessionAuth } from "@/lib/session/auth-context";

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const auth = await requireSessionAuth(request);
    const { sessionId } = await params;
    return NextResponse.json(await getSessionSupabaseSchema(sessionId, auth.userId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
