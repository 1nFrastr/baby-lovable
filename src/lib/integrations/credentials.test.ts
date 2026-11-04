import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ token: vi.fn(), keys: vi.fn() }));
vi.mock("./connect", () => ({ getAppConnectToken: m.token }));
vi.mock("./supabase-management", () => ({ getSupabaseProjectApiKeys: m.keys }));

import { resolveIntegrationCredentials } from "./credentials";
import { buildGeneratedAppEnv, type SessionIntegrationsRecord } from "./types";

const record = {
  sessionId: "app1", userId: "owner", supabaseStatus: "linked", supabaseLinkMethod: "connect",
  supabaseConnectConnector: "oauth/supabase", supabaseProjectRef: "userproject", supabaseProjectUrl: "https://userproject.supabase.co", supabaseSecrets: null,
  stripeStatus: "linked", stripeMode: "test", stripeConnectConnector: "stripe/app1", stripeConnectSubject: "app", stripeAccountId: "acct_app",
  stripeSecrets: { publishableKey: "", secretKey: "", webhookSecret: "whsec_private" },
} as SessionIntegrationsRecord;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "acct_app" })));
  m.token.mockImplementation(async (binding) => ({ token: binding.connector === "stripe/app1" ? "rk_test_current" : "management-current" }));
  m.keys.mockResolvedValue({ anonKey: "sb_publishable_current", serviceRoleKey: "sb_secret_current" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("runtime credential resolution", () => {
  it("gets current credentials at startup/publication without mutating stored records", async () => {
    const resolved = await resolveIntegrationCredentials(record);
    expect(m.token).toHaveBeenCalledWith({ connector: "stripe/app1", subject: "app" }, "owner", "app1", true);
    expect(m.keys).toHaveBeenCalledWith("management-current", "userproject");
    expect(record.supabaseSecrets).toBeNull();
    expect(record.stripeSecrets?.secretKey).toBe("");
    expect(buildGeneratedAppEnv(resolved)).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://userproject.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_current", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_current",
      STRIPE_SECRET_KEY: "rk_test_current", STRIPE_WEBHOOK_SECRET: "whsec_private",
    });
  });
  it("keeps Supabase administration independent of a disconnected Stripe grant", async () => {
    m.token.mockImplementation(async (binding) => {
      if (binding.connector === "stripe/app1") throw new Error("revoked");
      return { token: "management-current" };
    });
    await expect(resolveIntegrationCredentials(record, "supabase")).resolves.toMatchObject({ supabaseSecrets: { anonKey: "sb_publishable_current" } });
    expect(m.token).toHaveBeenCalledOnce();
  });
  it("blocks a different Stripe account even in the same payment mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "acct_other" })));
    await expect(resolveIntegrationCredentials(record, "stripe")).rejects.toThrow("changed accounts");
  });
  it("blocks mode changes during key rotation", async () => {
    m.token.mockResolvedValue({ token: "rk_live_rotated" });
    await expect(resolveIntegrationCredentials(record, "stripe")).rejects.toThrow("changed payment mode");
  });
  it("fails closed after authorization is revoked instead of using a stored key", async () => {
    m.token.mockRejectedValue(new Error("authorization revoked"));
    await expect(resolveIntegrationCredentials(record)).rejects.toThrow("revoked");
    expect(record.stripeSecrets?.secretKey).toBe("");
  });
});
