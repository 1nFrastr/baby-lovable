import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import {
  getSupabasePublishableKey,
  getSupabaseUrl,
  isSupabaseConfigured,
} from "@/lib/supabase/config";

function sanitizeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return "/sessions";
  }
  return next;
}

function redirectToLogin(origin: string, reason?: string) {
  const url = new URL("/login", origin);
  url.searchParams.set("error", "auth_callback_failed");
  if (reason && process.env.NODE_ENV === "development") {
    url.searchParams.set("reason", reason);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return redirectToLogin(request.nextUrl.origin, "supabase_not_configured");
  }

  const { searchParams, origin } = request.nextUrl;
  const next = sanitizeNextPath(searchParams.get("next"));
  const code = searchParams.get("code");

  if (!code) {
    return redirectToLogin(origin, "missing_code");
  }

  let response = NextResponse.redirect(`${origin}${next}`);

  const supabase = createServerClient(
    getSupabaseUrl()!,
    getSupabasePublishableKey()!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.redirect(`${origin}${next}`);
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (!error) {
    return response;
  }

  console.error("[auth/callback] exchangeCodeForSession:", error.message);
  return redirectToLogin(origin, error.message);
}
