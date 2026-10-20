import { NextResponse } from "next/server";

import { isCronRequestAuthorized } from "@/lib/cron/authorize-cron";
import { pingSupabase } from "@/lib/cron/supabase-keepalive";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (
    !isCronRequestAuthorized(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  if (!isSupabaseAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Supabase admin client is not configured." },
      { status: 503 },
    );
  }

  try {
    const result = await pingSupabase(getSupabaseAdminClient());
    return NextResponse.json({ ok: true, queries: result.queries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "keepalive failed";
    console.error("[supabase-keepalive]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
