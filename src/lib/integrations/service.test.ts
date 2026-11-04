import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), management: vi.fn(), getSessionMeta: vi.fn(), readSessionIntegrations: vi.fn(), linkStripeKeys: vi.fn(),
  linkSupabaseProject: vi.fn(), runCheckPreviewProbe: vi.fn(), stopAppServer: vi.fn(),
  saveSupabaseConnectAccount: vi.fn(), verifyAppConnector: vi.fn(), token: vi.fn(), start: vi.fn(), list: vi.fn(), keys: vi.fn(),
  saveVercelConnection: vi.fn(), vercelTeams: vi.fn(),
}));
vi.mock("./vercel-publish", () => ({ getVercelPublishProjection: async () => ({}), startVercelPublication: vi.fn() }));
vi.mock("./vercel-publish-store", () => ({ saveVercelConnection: mocks.saveVercelConnection }));
vi.mock("./vercel-api", () => ({ listVercelTeams: mocks.vercelTeams }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/session/store", () => ({ getSessionMeta: mocks.getSessionMeta }));
vi.mock("./store", () => ({
  ...mocks, claimDeploy: vi.fn(), setDeployState: vi.fn(), unlinkStripe: vi.fn(), unlinkSupabaseProject: vi.fn(),
}));
vi.mock("@/lib/sandbox/preview", () => ({ runCheckPreviewProbe: mocks.runCheckPreviewProbe, stopAppServer: mocks.stopAppServer }));
vi.mock("./connect", () => ({
  configuredSupabaseConnector: () => "oauth/supabase",
  configuredStripeConnector: () => "api-key/stripe-users",
  configuredVercelConnector: () => "vercel/baby-publish",
  verifyAppConnector: mocks.verifyAppConnector, getAppConnectToken: mocks.token, startAppConnectAuthorization: mocks.start,
}));
vi.mock("./supabase-management", () => ({ supabaseManagementRequest: mocks.management, listSupabaseProjects: mocks.list, getSupabaseProjectApiKeys: mocks.keys, supabaseProjectUrl: (ref: string) => `https://${ref}.supabase.co` }));

import { completeSessionConnection, startSessionConnection, getIntegrationsStatus, linkSessionStripe, linkSessionSupabaseViaConnect, provisionSessionSupabase, normalizeSupabaseUrl, validateStripeKeys } from "./service";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INTEGRATION_SECRETS_KEY", "a".repeat(64));
  mocks.getSessionMeta.mockResolvedValue({ id: "sess_1", userId: "owner", runStatus: "idle" });
  mocks.readSessionIntegrations.mockResolvedValue(null);
  mocks.runCheckPreviewProbe.mockResolvedValue({ ok: true });
  mocks.start.mockImplementation(async (_binding, _user, _session, callback) => `https://connect.vercel.com/authorize?return=${encodeURIComponent(callback)}`);
  mocks.token.mockResolvedValue({ token: "management-private" });
  mocks.list.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function authorization(provider: "supabase" | "stripe" | "vercel" = "supabase") {
  const start = await startSessionConnection({ userId: "owner", sessionId: "sess_1", provider, origin: "https://builder.example" });
  const callback = new URL(new URL(start.authorizeUrl).searchParams.get("return") ?? start.authorizeUrl);
  return { state: callback.searchParams.get("state")!, cookieValue: start.cookieValue, userId: "owner", provider };
}

describe("Connect identity binding", () => {
  it("connects Vercel to the authenticated owner without storing its token", async () => {
    const input = await authorization("vercel");
    mocks.vercelTeams.mockResolvedValue([{ id: "team_own", name: "My team", slug: "mine" }]);
    await expect(completeSessionConnection(input)).resolves.toEqual({ sessionId: "sess_1", provider: "vercel" });
    expect(mocks.token).toHaveBeenCalledWith({ connector: "vercel/baby-publish", subject: "user", scope: "owner" }, "owner", "sess_1", true);
    expect(mocks.saveVercelConnection).toHaveBeenCalledWith("owner", "vercel/baby-publish");
    expect(JSON.stringify(mocks.saveVercelConnection.mock.calls)).not.toContain("management-private");
  });
  it("does not accept a Vercel grant when the API rejects Team access", async () => {
    const input = await authorization("vercel");
    mocks.vercelTeams.mockRejectedValue(new Error("permission denied"));
    await expect(completeSessionConnection(input)).rejects.toThrow();
    expect(mocks.saveVercelConnection).not.toHaveBeenCalled();
  });
  it("keeps the binding encrypted and rejects another logged-in owner", async () => {
    const input = await authorization();
    expect(Buffer.from(input.cookieValue, "base64").toString()).not.toContain("oauth/supabase");
    await expect(completeSessionConnection({ ...input, userId: "other" })).rejects.toThrow("expired");
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("rejects tampered cookies, a different provider, and mismatched state before requesting credentials", async () => {
    const input = await authorization();
    await expect(completeSessionConnection({ ...input, state: "other" })).rejects.toThrow("expired");
    await expect(completeSessionConnection({ ...input, provider: "stripe" })).rejects.toThrow("expired");
    await expect(completeSessionConnection({ ...input, cookieValue: "not-a-cookie" })).rejects.toThrow("expired");
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("rejects expired authorization", async () => {
    vi.useFakeTimers();
    try {
      const input = await authorization();
      vi.setSystemTime(Date.now() + 600_001);
      await expect(completeSessionConnection(input)).rejects.toThrow("expired");
      expect(mocks.token).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("rechecks current ownership before accepting authorization", async () => {
    const input = await authorization();
    mocks.getSessionMeta.mockRejectedValue(new Error("Forbidden"));
    await expect(completeSessionConnection(input)).rejects.toThrow("Forbidden");
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("requires an idle app before starting or completing connection changes", async () => {
    const input = await authorization();
    mocks.getSessionMeta.mockResolvedValue({ runStatus: "running" });
    await expect(completeSessionConnection(input)).rejects.toThrow("Wait");
    await expect(authorization()).rejects.toThrow("Wait");
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("verifies the current grant and persists only a Supabase connector reference", async () => {
    const input = await authorization();
    await expect(completeSessionConnection(input)).resolves.toEqual({ sessionId: "sess_1", provider: "supabase" });
    expect(mocks.token).toHaveBeenCalledWith({ connector: "oauth/supabase", subject: "user" }, "owner", "sess_1", true);
    expect(mocks.saveSupabaseConnectAccount).toHaveBeenCalledWith("sess_1", "owner", "oauth/supabase");
    expect(JSON.stringify(mocks.saveSupabaseConnectAccount.mock.calls)).not.toContain("management-private");
  });
  it("does not overwrite a completed Stripe binding by replaying a callback", async () => {
    const input = await authorization("stripe");
    mocks.readSessionIntegrations.mockResolvedValue({ stripeStatus: "linked", userId: "owner" });
    await expect(completeSessionConnection(input)).rejects.toThrow("already has a connection");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.linkStripeKeys).not.toHaveBeenCalled();
  });
  it("uses an operator-assigned managed connector without sending the owner to team setup", async () => {
    mocks.readSessionIntegrations.mockResolvedValue({ userId: "owner", stripeConnectConnector: "stripe/dedicated", stripeConnectSubject: "app", stripeStatus: "disconnected" });
    const result = await startSessionConnection({ userId: "owner", sessionId: "sess_1", provider: "stripe", origin: "https://builder.example" });
    expect(new URL(result.authorizeUrl).origin).toBe("https://builder.example");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.verifyAppConnector).toHaveBeenCalledWith({ connector: "stripe/dedicated", subject: "app" }, "stripe");
  });
  it("does not bind a project outside the authorized account", async () => {
    mocks.readSessionIntegrations.mockResolvedValue({ userId: "owner", supabaseConnectConnector: "oauth/supabase" });
    await expect(linkSessionSupabaseViaConnect({ userId: "owner", sessionId: "sess_1", projectRef: "other" })).rejects.toThrow("not found");
    expect(mocks.linkSupabaseProject).not.toHaveBeenCalled();
  });
  it("validates runtime-key access without storing project keys", async () => {
    mocks.readSessionIntegrations.mockResolvedValue({ userId: "owner", supabaseConnectConnector: "oauth/supabase" });
    mocks.list.mockResolvedValue([{ ref: "app", name: "My app", status: "ACTIVE_HEALTHY" }]);
    mocks.keys.mockResolvedValue({ anonKey: "public", serviceRoleKey: "private-project" });
    await linkSessionSupabaseViaConnect({ userId: "owner", sessionId: "sess_1", projectRef: "app" });
    expect(mocks.linkSupabaseProject).toHaveBeenCalledWith(expect.objectContaining({ linkMethod: "connect", connectConnector: "oauth/supabase", secrets: null }));
    expect(JSON.stringify(mocks.linkSupabaseProject.mock.calls)).not.toContain("private-project");
  });
  it("validates Stripe mode and saves no Connect-issued provider key", async () => {
    const input = await authorization("stripe");
    mocks.token.mockResolvedValue({ token: "rk_test_PRIVATE" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ livemode: false })).mockResolvedValueOnce(Response.json({ id: "acct_app" })));
    await completeSessionConnection(input);
    expect(mocks.linkStripeKeys).toHaveBeenCalledWith(expect.objectContaining({ connectConnector: "api-key/stripe-users", connectSubject: "user", mode: "test", secrets: { secretKey: "", publishableKey: "" } }));
    expect(JSON.stringify(mocks.linkStripeKeys.mock.calls)).not.toContain("rk_test_PRIVATE");
  });
  it("rejects a changed Stripe mode before saving", async () => {
    const input = await authorization("stripe");
    mocks.token.mockResolvedValue({ token: "rk_test_PRIVATE" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ livemode: true })));
    await expect(completeSessionConnection(input)).rejects.toThrow("mode");
    expect(mocks.linkStripeKeys).not.toHaveBeenCalled();
  });
});

describe("credential validation and activation", () => {
  it.each(["http://abc.supabase.co", "https://abc.supabase.co/evil", "https://user:pass@abc.supabase.co", "https://abc.supabase.co:444", "https://abc.supabase.co?token=secret", "https://abc.supabase.co.evil.test"])("rejects unsafe project URL %s", (url) => {
    expect(() => normalizeSupabaseUrl(url)).toThrow();
  });
  it("rejects mixed payment modes and control-character injection", () => {
    expect(() => validateStripeKeys("pk_test_abc", "sk_live_abc")).toThrow("same");
    expect(() => validateStripeKeys("pk_test_abc", "sk_test_abc\nEVIL=1")).toThrow();
    expect(() => validateStripeKeys("pk_test_abc", "rk_test_abc", "invalid")).toThrow("signing secret");
    expect(() => validateStripeKeys("pk_test_abc", "rk_test_abc")).not.toThrow();
  });
  it("does not save a payment key the provider rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret echo", { status: 401 })));
    await expect(linkSessionStripe({ sessionId: "sess_1", userId: "owner", publishableKey: "pk_test_abc", secretKey: "sk_test_abc" })).rejects.toThrow("Stripe");
    expect(mocks.linkStripeKeys).not.toHaveBeenCalled();
  });
  it("reports saved settings separately when preview activation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ livemode: false })));
    mocks.runCheckPreviewProbe.mockRejectedValue(new Error("provider error with secret"));
    const result = await linkSessionStripe({ sessionId: "sess_1", userId: "owner", publishableKey: "pk_test_abc", secretKey: "sk_test_abc" });
    expect(mocks.linkStripeKeys).toHaveBeenCalledOnce();
    expect(result.preview.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("sk_test_abc");
    expect(JSON.stringify(result)).not.toContain("provider error");
  });
  it("stops the old preview before activating new credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ livemode: false })));
    mocks.runCheckPreviewProbe.mockResolvedValue({ ok: true });
    const result = await linkSessionStripe({ sessionId: "sess_1", userId: "owner", publishableKey: "pk_test_abc", secretKey: "sk_test_abc" });
    expect(result.preview.status).toBe("ready");
    expect(mocks.stopAppServer.mock.invocationCallOrder[0]).toBeLessThan(mocks.runCheckPreviewProbe.mock.invocationCallOrder[0]);
  });
  it("loads status without decrypting credentials or requesting a provider token", async () => {
    await getIntegrationsStatus("sess_1", "owner");
    expect(mocks.readSessionIntegrations).toHaveBeenCalledWith("sess_1", false);
    expect(mocks.token).not.toHaveBeenCalled();
  });
});

describe("Supabase project provisioning", () => {
  it("resumes an existing reservation without sending another create request", async () => {
    mocks.readSessionIntegrations.mockResolvedValue({ supabaseConnectConnector: "oauth/supabase" });
    const single = vi.fn().mockResolvedValue({ data: { id: "reservation", resource: "my-org" } });
    const query = { eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(), single };
    mocks.admin.mockReturnValue({ from: () => ({
      insert: async () => ({ error: { code: "23505" } }),
      select: () => query,
    }) });
    mocks.management.mockResolvedValueOnce([{ slug: "my-org" }]).mockResolvedValueOnce({ projects: [] });
    await expect(provisionSessionSupabase("owner", "sess_1", "my-org")).resolves.toBeNull();
    expect(mocks.management.mock.calls.map(([, path]) => path)).toEqual([
      "/organizations", "/organizations/my-org/projects?search=baby-app-reservation&limit=2",
    ]);
    expect(mocks.linkSupabaseProject).not.toHaveBeenCalled();
  });

  it("rejects organizations outside the user's grant before reserving a project", async () => {
    mocks.readSessionIntegrations.mockResolvedValue({ supabaseConnectConnector: "oauth/supabase" });
    mocks.management.mockResolvedValue([{ slug: "my-org" }]);
    await expect(provisionSessionSupabase("owner", "sess_1", "other")).rejects.toThrow("Choose an organization");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
