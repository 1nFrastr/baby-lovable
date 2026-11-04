import { NextResponse } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

const marker = "NEXT_PUBLIC_BABY_LOVABLE_EMBEDDED_PREVIEW";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("sets and clears auth cookies in the same partition for an embedded preview", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv(marker, "1");
  const { supabaseCookieOptions } = await import("../../../templates/nextjs-starter/src/lib/supabase/cookie-options");
  const response = NextResponse.json({});
  response.cookies.set("test-auth", "session", supabaseCookieOptions);
  expect(response.headers.get("set-cookie")).toMatch(/Secure.*SameSite=none.*Partitioned/i);
  response.cookies.set("test-auth", "", { ...supabaseCookieOptions, maxAge: 0 });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("set-cookie")).toContain("Partitioned");
});

it.each([["production", "1"], ["development", ""]])("leaves default cookies in %s without an active preview", async (mode, value) => {
  vi.stubEnv("NODE_ENV", mode);
  vi.stubEnv(marker, value);
  const { supabaseCookieOptions } = await import("../../../templates/nextjs-starter/src/lib/supabase/cookie-options");
  expect(supabaseCookieOptions).toBeUndefined();
});
