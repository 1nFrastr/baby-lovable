import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getSupabaseProjectApiKeys,
  SupabaseManagementError,
  supabaseManagementRequest,
} from "./supabase-management";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Supabase Management API transport", () => {
  it("sends JSON with host credentials and disables redirects and caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      supabaseManagementRequest("host-token", "/projects/ref/database/query", {
        method: "POST",
        headers: { Authorization: "Bearer overridden-token" },
        body: { query: "select 1" },
      }),
    ).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.supabase.com/v1/projects/ref/database/query");
    expect(init.body).toBe('{"query":"select 1"}');
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer host-token");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves multipart bodies and lets fetch supply their boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "function" }));
    vi.stubGlobal("fetch", fetchMock);
    const body = new FormData();
    body.set("file", new Blob(["Deno.serve(() => new Response('ok'))"]), "index.ts");
    await supabaseManagementRequest("token", "/projects/ref/functions/deploy?slug=hello", {
      method: "POST",
      body,
      headers: { "Content-Type": "multipart/form-data" },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/functions/deploy?slug=hello");
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it.each([
    "https://attacker.example/projects",
    "//attacker.example/projects",
    "/../oauth/token",
    "/%2e%2e/oauth/token",
    "/projects\\attacker.example",
    "/projects#fragment",
  ])("rejects a path outside the API boundary: %s", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(supabaseManagementRequest("token", path)).rejects.toThrow(
      "Invalid Management API path",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps status without echoing provider secrets or retrying mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ message: "query failed with sk_live_secret" }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = await supabaseManagementRequest("token", "/projects/ref/database/query", {
      method: "POST", body: { query: "select 'private data'" },
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SupabaseManagementError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).not.toContain("sk_live_secret");
    expect((error as Error).message).not.toContain("private data");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Bearer secret-token")));
    await expect(supabaseManagementRequest("secret-token", "/projects")).rejects.toThrow(
      "Supabase Management API request could not be completed",
    );
  });

  it("rejects malformed success JSON rather than silently treating it as missing data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(supabaseManagementRequest("token", "/projects")).rejects.toThrow(
      "returned invalid JSON",
    );
  });

  it("accepts an empty 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(
      supabaseManagementRequest("token", "/projects/ref/functions/old", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });

  it("prefers modern runtime keys and keeps legacy keys as a fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([
      { name: "anon", api_key: "legacy-public" }, { name: "service_role", api_key: "legacy-private" },
      { name: "default", api_key: "sb_publishable_current" }, { name: "default", api_key: "sb_secret_current" },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSupabaseProjectApiKeys("management-token", "app")).resolves.toEqual({ anonKey: "sb_publishable_current", serviceRoleKey: "sb_secret_current" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/projects/app/api-keys?reveal=true");
  });

  it("never returns a masked secret key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([
      { name: "default", api_key: "sb_publishable_current" },
      { name: "default", api_key: "sb_secret_abc····" },
      { name: "service_role", api_key: "legacy-private" },
    ])));
    await expect(getSupabaseProjectApiKeys("management-token", "app")).resolves.toEqual({ anonKey: "sb_publishable_current", serviceRoleKey: "legacy-private" });
  });
});
