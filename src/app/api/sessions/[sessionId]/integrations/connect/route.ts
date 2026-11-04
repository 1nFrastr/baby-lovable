import { NextResponse } from "next/server";
import { z } from "zod";

import { integrationErrorResponse } from "@/app/api/integrations/_responses";
import { startSessionConnection } from "@/lib/integrations/service";
import { requireSessionAuth } from "@/lib/session/auth-context";

const schema = z.strictObject({ provider: z.enum(["supabase", "stripe", "vercel"]) });

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const origin = new URL(request.url).origin;
  const site = request.headers.get("sec-fetch-site");
  if (request.headers.get("origin") !== origin || (site !== null && site !== "same-origin" && site !== "none")) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }
  try {
    const auth = await requireSessionAuth(request);
    const { sessionId } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Choose a supported service." }, { status: 400 });
    const { authorizeUrl, cookieValue } = await startSessionConnection({ userId: auth.userId, sessionId, provider: parsed.data.provider, origin });
    const response = NextResponse.json({ authorizeUrl }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(`bl_connect_${parsed.data.provider}`, cookieValue, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600,
    });
    return response;
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
