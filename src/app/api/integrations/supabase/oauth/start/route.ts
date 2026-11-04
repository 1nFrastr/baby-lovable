import { NextResponse } from "next/server";

/** Old bookmarks must not start the retired host-managed OAuth exchange. */
export async function GET() {
  return NextResponse.json({ error: "Open your app's Backend panel to connect Supabase." }, {
    status: 410, headers: { "Cache-Control": "no-store" },
  });
}
