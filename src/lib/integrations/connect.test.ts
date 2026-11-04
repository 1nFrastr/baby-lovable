import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectError } from "@vercel/connect";

const sdk = vi.hoisted(() => ({ token: vi.fn(), metadata: vi.fn(), start: vi.fn() }));
vi.mock("@vercel/connect", async (original) => ({
  ...await original<typeof import("@vercel/connect")>(),
  getTokenResponse: sdk.token, getConnectorMetadata: sdk.metadata, startAuthorization: sdk.start,
}));

import { appConnectSubject, ownerConnectSubject, getAppConnectToken, startAppConnectAuthorization, verifyAppConnector } from "./connect";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VERCEL_OIDC_TOKEN", "project-private");
  vi.stubEnv("VERCEL_CONNECT_ACCESS_TOKEN", "operator-private");
  vi.stubEnv("VERCEL", "");
  sdk.token.mockResolvedValue({ token: "provider-private", tokenId: "stk_safe", expiresAt: Date.now() + 60_000 });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Connect credential boundary", () => {
  it("shares a Vercel owner grant across apps while isolating different owners", async () => {
    const binding = { connector: "vercel/publish", subject: "user" as const, scope: "owner" as const };
    await getAppConnectToken(binding, "owner", "app1");
    await getAppConnectToken(binding, "owner", "app2");
    expect(sdk.token.mock.calls[0][1].subject).toEqual({ type: "user", id: ownerConnectSubject("owner") });
    expect(sdk.token.mock.calls[1][1].subject).toEqual(sdk.token.mock.calls[0][1].subject);
    expect(ownerConnectSubject("other")).not.toBe(ownerConnectSubject("owner"));
  });
  it("rejects Vercel MCP and API-key connectors for delegated publication", async () => {
    const binding = { connector: "vercel/publish", subject: "user" as const, scope: "owner" as const };
    for (const type of ["mcp", "api-key"]) {
      sdk.metadata.mockResolvedValue({ service: "vercel", type });
      await expect(verifyAppConnector(binding, "vercel")).rejects.toMatchObject({ code: "connect_provider_mismatch" });
    }
    sdk.metadata.mockResolvedValue({ service: "vercel", type: "oauth" });
    await expect(verifyAppConnector(binding, "vercel")).resolves.toMatchObject({ type: "oauth" });
  });
  it("isolates app grants by both owner and session", async () => {
    expect(appConnectSubject("owner", "app1")).not.toBe(appConnectSubject("owner", "app2"));
    expect(appConnectSubject("owner", "app1")).not.toBe(appConnectSubject("other", "app1"));
    const binding = { connector: "oauth/supabase", subject: "user" as const };
    await getAppConnectToken(binding, "owner", "app1", true);
    expect(sdk.token).toHaveBeenCalledWith("oauth/supabase", { subject: { type: "user", id: appConnectSubject("owner", "app1") } }, { forceRefresh: true });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("provider-private");
    expect(vi.mocked(console.info).mock.calls[0][0]).toContain("stk_safe");
  });
  it("does not substitute an operator access token for another user's project identity", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    await expect(getAppConnectToken({ connector: "oauth/supabase", subject: "user" }, "owner", "app1")).rejects.toMatchObject({ code: "connect_identity_missing" });
    expect(sdk.token).not.toHaveBeenCalled();
  });
  it("allows a dedicated app connector to use a host-only scoped access token", async () => {
    await getAppConnectToken({ connector: "stripe/app1", subject: "app" }, "owner", "app1");
    expect(sdk.token).toHaveBeenCalledWith("stripe/app1", { subject: { type: "app" } }, { vercelToken: "operator-private", forceRefresh: false });
  });
  it("sanitizes SDK exceptions and preserves a reconnect error code", async () => {
    sdk.token.mockRejectedValue(new ConnectError("private-provider-body", { code: "user_authorization_required", vendor: { secret: "provider-private" } }));
    await expect(getAppConnectToken({ connector: "oauth/supabase", subject: "user" }, "owner", "app1")).rejects.toMatchObject({ code: "connect_authorization_required", status: 409 });
    try { await getAppConnectToken({ connector: "oauth/supabase", subject: "user" }, "owner", "app1"); } catch (error) {
      expect(String(error)).not.toContain("private-provider-body");
      expect(JSON.stringify(error)).not.toContain("provider-private");
    }
  });
  it("rejects an expired provider token", async () => {
    sdk.token.mockResolvedValue({ token: "expired", expiresAt: Date.now() - 1 });
    await expect(getAppConnectToken({ connector: "stripe/app1", subject: "app" }, "owner", "app1")).rejects.toMatchObject({ code: "connect_authorization_required" });
  });
  it("bounds SDK waits without retrying the request", async () => {
    vi.useFakeTimers();
    sdk.token.mockReturnValue(new Promise(() => {}));
    const assertion = expect(getAppConnectToken({ connector: "stripe/app1", subject: "app" }, "owner", "app1")).rejects.toMatchObject({ code: "connect_timeout" });
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    expect(sdk.token).toHaveBeenCalledOnce();
  });
  it("starts authorization using a host-derived subject and fixed callback", async () => {
    sdk.start.mockResolvedValue({ url: "https://connect.vercel.com/authorize" });
    await startAppConnectAuthorization({ connector: "oauth/supabase", subject: "user" }, "owner", "app1", "https://builder.example/api/integrations/connect/callback");
    expect(sdk.start).toHaveBeenCalledWith("oauth/supabase", { subject: { type: "user", id: appConnectSubject("owner", "app1") } }, { callbackUrl: "https://builder.example/api/integrations/connect/callback", expiresInMs: 600_000 });
  });
  it("never uses a connector-level Stripe key as a shared user connection", async () => {
    sdk.metadata.mockResolvedValue({ id: "scl_shared", service: "stripe", type: "api-key", vendor: { subjectType: "app" } });
    await expect(verifyAppConnector({ connector: "api-key/shared", subject: "user" }, "stripe")).rejects.toMatchObject({ code: "connect_subject_mismatch" });
    sdk.metadata.mockResolvedValue({ id: "scl_users", service: "stripe", type: "api-key", vendor: { subjectType: "user" } });
    await expect(verifyAppConnector({ connector: "api-key/users", subject: "user" }, "stripe")).resolves.toMatchObject({ id: "scl_users" });
  });
  it("rejects a connector for another provider or an unsupported credential class", async () => {
    sdk.metadata.mockResolvedValue({ service: "github", type: "oauth" });
    await expect(verifyAppConnector({ connector: "oauth/wrong", subject: "user" }, "supabase")).rejects.toMatchObject({ code: "connect_provider_mismatch" });
    sdk.metadata.mockResolvedValue({ service: "stripe", type: "oauth" });
    await expect(verifyAppConnector({ connector: "oauth/wrong", subject: "user" }, "stripe")).rejects.toMatchObject({ code: "connect_provider_mismatch" });
  });
});
