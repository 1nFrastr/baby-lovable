import { NextResponse } from "next/server";

/** Vercel Connect now exchanges provider authorization codes. */
export async function GET() {
  const response = NextResponse.json({ error: "This connection request has expired. Reconnect Supabase from the Backend panel." }, {
    status: 410, headers: { "Cache-Control": "no-store" },
  });
  response.cookies.set("bl_supabase_oauth", "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
