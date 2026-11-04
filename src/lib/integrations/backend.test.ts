import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getSessionMeta: vi.fn(), readSessionIntegrations: vi.fn(), request: vi.fn(), token: vi.fn(),
  getIntegrationsStatus: vi.fn(), activate: vi.fn(), linkStripeKeys: vi.fn(), insert: vi.fn(), update: vi.fn(), eq: vi.fn(),
}));
vi.mock("@/lib/session/store", () => ({ getSessionMeta: m.getSessionMeta }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => ({ from: () => ({ insert: m.insert, update: m.update }) }) }));
vi.mock("./store", () => ({ readSessionIntegrations: m.readSessionIntegrations, linkStripeKeys: m.linkStripeKeys }));
vi.mock("./supabase-management", () => ({ supabaseManagementRequest: m.request }));
vi.mock("./connect", () => ({ getAppConnectToken: m.token }));
vi.mock("./service", async (original) => {
  const actual = await original<typeof import("./service")>();
  return { IntegrationError: actual.IntegrationError, getIntegrationsStatus: m.getIntegrationsStatus, activateIntegrationSettings: m.activate };
});

import { runBackendOperation } from "./backend";

const linked = {
  userId: "owner", supabaseStatus: "linked", supabaseProjectRef: "userproject", supabaseProjectUrl: "https://userproject.supabase.co",
  supabaseLinkMethod: "connect", supabaseConnectConnector: "oauth/supabase", supabaseSecrets: { anonKey: "public-key", serviceRoleKey: "server-secret" },
  stripeStatus: "linked", stripeMode: "test", stripeSecrets: { publishableKey: "pk_test_abc", secretKey: "sk_test_private" },
  deployStatus: "live", deployUrl: "https://userapp.example",
};

beforeEach(() => {
  vi.resetAllMocks();
  m.getSessionMeta.mockResolvedValue({ userId: "owner", activeTurnId: "turn_1" });
  m.readSessionIntegrations.mockResolvedValue(structuredClone(linked));
  m.token.mockResolvedValue({ token: "management-secret" });
  m.insert.mockResolvedValue({ error: null });
  m.eq.mockResolvedValue({ error: null });
  m.update.mockReturnValue({ eq: m.eq });
  m.request.mockResolvedValue({});
  m.activate.mockResolvedValue({ preview: { status: "ready", error: null } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("host-managed backend operations", () => {
  it("blocks cancelled/superseded turns before auditing or contacting providers", async () => {
    await expect(runBackendOperation({ action: "inspect_schema" }, "sess_1", "old_turn")).rejects.toThrow("superseded");
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.request).not.toHaveBeenCalled();
  });
  it("fails closed when operation history cannot be persisted", async () => {
    m.insert.mockResolvedValue({ error: { message: "db unavailable" } });
    await expect(runBackendOperation({ action: "apply_migration", name: "new_table", sql: "SELECT 1" }, "sess_1", "turn_1")).rejects.toThrow("history");
    expect(m.request).not.toHaveBeenCalled();
  });
  it("targets the user project and records only digest metadata for SQL", async () => {
    const sql = "CREATE TABLE public.notes(id int); ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;";
    const result = await runBackendOperation({ action: "apply_migration", name: "notes_v1", sql }, "sess_1", "turn_1");
    expect(m.request).toHaveBeenCalledWith("management-secret", "/projects/userproject/database/query", expect.objectContaining({ method: "POST" }));
    expect(JSON.stringify(m.insert.mock.calls)).not.toContain(sql);
    expect(JSON.stringify(m.insert.mock.calls)).not.toContain("management-secret");
    expect(JSON.stringify(result)).not.toContain("server-secret");
    expect(result.ok).toBe(true);
  });
  it("does not grant project administration from manual runtime keys", async () => {
    m.readSessionIntegrations.mockResolvedValue({ ...linked, supabaseLinkMethod: "manual" });
    await expect(runBackendOperation({ action: "inspect_schema" }, "sess_1")).rejects.toThrow("Reconnect your Supabase account");
    expect(m.request).not.toHaveBeenCalled();
  });
  it("sanitizes provider responses and records failure for diagnosis", async () => {
    m.request.mockRejectedValue(new Error("provider echoed server-secret"));
    await expect(runBackendOperation({ action: "inspect_schema" }, "sess_1")).rejects.toThrow("provider could not complete");
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_code: "provider_failed" }));
    expect(JSON.stringify(m.update.mock.calls)).not.toContain("server-secret");
  });
  it("protects deployed functions and never returns management credentials", async () => {
    const result = await runBackendOperation({ action: "deploy_function", name: "hello", source: "Deno.serve(() => new Response('hello'));" }, "sess_1");
    const body = m.request.mock.calls[0][2].body as FormData;
    expect(JSON.parse(body.get("metadata") as string).verify_jwt).toBe(true);
    expect(body.get("file")).toBeInstanceOf(Blob);
    expect(JSON.stringify(result)).not.toContain("management-secret");
  });
  it("stores Stripe signing secrets without disclosing them in tool output or audit", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "we_1", secret: "whsec_PRIVATE" }));
    vi.stubGlobal("fetch", fetch);
    const result = await runBackendOperation({ action: "configure_stripe_webhook" }, "sess_1");
    expect(m.linkStripeKeys).toHaveBeenCalledWith(expect.objectContaining({ secrets: expect.objectContaining({ webhookSecret: "whsec_PRIVATE" }) }));
    expect(JSON.stringify(result)).not.toContain("whsec_PRIVATE");
    expect(JSON.stringify(m.insert.mock.calls)).not.toContain("whsec_PRIVATE");
    expect(result).toMatchObject({ redeployRequired: true, endpoint: "https://userapp.example/api/stripe/webhook" });
    expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).toMatch(/^baby-webhook-/);
  });
  it("never persists a Connect-issued Stripe key when saving a webhook", async () => {
    m.readSessionIntegrations.mockResolvedValue({ ...linked, stripeConnectConnector: "stripe/app", stripeConnectSubject: "app", stripeAccountId: "acct_app", stripeSecrets: { publishableKey: "", secretKey: "" } });
    m.token.mockResolvedValue({ token: "rk_test_ROTATED" });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "acct_app" }))
      .mockResolvedValueOnce(Response.json({ data: [], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "we_1", secret: "whsec_PRIVATE" })));
    await runBackendOperation({ action: "configure_stripe_webhook" }, "sess_1");
    expect(m.linkStripeKeys).toHaveBeenCalledWith(expect.objectContaining({ connectConnector: "stripe/app", connectSubject: "app", secrets: expect.objectContaining({ secretKey: "", webhookSecret: "whsec_PRIVATE" }) }));
    expect(JSON.stringify(m.linkStripeKeys.mock.calls)).not.toContain("rk_test_ROTATED");
  });
  it("reuses a webhook only when its stored secret is bound to that exact endpoint", async () => {
    m.readSessionIntegrations.mockResolvedValue({ ...linked, stripeSecrets: { ...linked.stripeSecrets, webhookSecret: "whsec_PRIVATE", webhookEndpointId: "we_known", webhookEndpointUrl: "https://userapp.example/api/stripe/webhook" } });
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "we_known", url: "https://userapp.example/api/stripe/webhook", status: "enabled", metadata: { baby_session_id: "sess_1" } }], has_more: false }));
    vi.stubGlobal("fetch", fetch);
    await expect(runBackendOperation({ action: "configure_stripe_webhook" }, "sess_1")).resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(m.linkStripeKeys).not.toHaveBeenCalled();
  });
  it("does not assume a manually supplied secret belongs to a registered endpoint", async () => {
    m.readSessionIntegrations.mockResolvedValue({ ...linked, stripeSecrets: { ...linked.stripeSecrets, webhookSecret: "whsec_UNRELATED" } });
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "we_known", url: "https://userapp.example/api/stripe/webhook", status: "enabled", metadata: { baby_session_id: "sess_1" } }], has_more: false }));
    vi.stubGlobal("fetch", fetch);
    await expect(runBackendOperation({ action: "configure_stripe_webhook" }, "sess_1")).rejects.toThrow("reconciliation");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not recreate a known webhook whose signing secret needs recovery", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ url: "https://userapp.example/api/stripe/webhook", status: "enabled", metadata: { baby_session_id: "sess_1" } }], has_more: false }));
    vi.stubGlobal("fetch", fetch);
    await expect(runBackendOperation({ action: "configure_stripe_webhook" }, "sess_1")).rejects.toThrow("reconciliation");
    expect(fetch).toHaveBeenCalledOnce();
    expect(m.linkStripeKeys).not.toHaveBeenCalled();
  });
});
