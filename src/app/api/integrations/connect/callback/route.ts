import { NextRequest, NextResponse } from "next/server";

import { completeSessionConnection } from "@/lib/integrations/service";
import { requireSessionAuth } from "@/lib/session/auth-context";
import { getSessionMeta } from "@/lib/session/store";

export async function GET(request: NextRequest) {
  const target = new URL("/", request.url);
  const provider = request.nextUrl.searchParams.get("provider");
  const validProvider = provider === "supabase" || provider === "stripe" || provider === "vercel";
  let userId: string | null = null;
  try {
    const auth = await requireSessionAuth(request);
    userId = auth.userId;
    const state = request.nextUrl.searchParams.get("state");
    if (!validProvider || !state || request.nextUrl.searchParams.has("error")) throw new Error("Authorization incomplete");
    const result = await completeSessionConnection({
      userId: auth.userId, provider, state,
      cookieValue: request.cookies.get(`bl_connect_${provider}`)?.value ?? null,
    });
    target.searchParams.set("session", result.sessionId);
    target.searchParams.set("backend", `${result.provider}_connected`);
    if (result.preview?.status === "error") target.searchParams.set("backend_preview", "error");
  } catch {
    // Do not reflect provider messages, identities, or unverified return URLs.
    target.searchParams.set("backend", "error");
    if (provider === "vercel") {
      target.searchParams.set("backend_provider", "vercel");
      const sessionId = request.nextUrl.searchParams.get("session");
      if (userId && sessionId) {
        // A rejected consent should still return to Publish. The navigation hint
        // is untrusted, so resolve it through the authenticated ownership check.
        const session = await getSessionMeta(sessionId, { userId }).catch(() => null);
        if (session) target.searchParams.set("session", sessionId);
      }
    }
  }
  const response = NextResponse.redirect(target);
  response.headers.set("Cache-Control", "no-store");
  if (validProvider) response.cookies.set(`bl_connect_${provider}`, "", {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0,
  });
  return response;
}
