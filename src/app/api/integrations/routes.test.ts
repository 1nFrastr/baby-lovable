import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/integrations/service", () => ({
  IntegrationError: class IntegrationError extends Error {
    constructor(message: string, public status = 400) { super(message); }
  },
  getIntegrationsStatus: vi.fn(),
  linkSessionStripe: vi.fn(),
  linkSessionSupabaseManual: vi.fn(),
  linkSessionSupabaseViaConnect: vi.fn(),
  publishSession: vi.fn(),
  unlinkSessionStripe: vi.fn(),
  unlinkSessionSupabase: vi.fn(),
  listLinkedUserSupabaseProjects: vi.fn(),
  startSessionConnection: vi.fn(),
  completeSessionConnection: vi.fn(),
  refreshSessionConnections: vi.fn(),
}));
vi.mock("@/lib/session/auth-context", () => ({
  requireSessionAuth: vi.fn(),
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SessionAccessDeniedError: class SessionAccessDeniedError extends Error {},
}));
vi.mock("@/lib/session/store", () => ({ getSessionMeta: vi.fn() }));
vi.mock("@/lib/integrations/vercel-publish", async (original) => ({
  ...await original<typeof import("@/lib/integrations/vercel-publish")>(),
  listPublishTeams: vi.fn(), choosePublishTeam: vi.fn(), disconnectPublishAccount: vi.fn(), resumeVercelPublication: vi.fn(),
}));

import { IntegrationProviderError } from "@/lib/integrations/http";
import * as service from "@/lib/integrations/service";
import * as publishing from "@/lib/integrations/vercel-publish";
import { GET as getTeams } from "../sessions/[sessionId]/integrations/vercel/route";
import { SupabaseManagementError } from "@/lib/integrations/supabase-management";
import { emptyIntegrationsProjection } from "@/lib/integrations/types";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSessionMeta } from "@/lib/session/store";

import { GET as getStatus, POST } from "../sessions/[sessionId]/integrations/route";
import { GET as getProjects } from "../sessions/[sessionId]/integrations/supabase/projects/route";
import { GET as callback } from "./connect/callback/route";
import { POST as start } from "../sessions/[sessionId]/integrations/connect/route";

const origin = "https://builder.example";
const endpoint = `${origin}/api/sessions/sess_owned/integrations`;
const context = () => ({ params: Promise.resolve({ sessionId: "sess_owned" }) });
const result = () => ({
  ...emptyIntegrationsProjection({ secretsConfigured: true }),
  preview: { status: "ready" as const, error: null },
});
const secret = "provider-secret-DO-NOT-EXPOSE";

function post(body: unknown, headers: Record<string, string | undefined> = {}) {
  const requestHeaders = new Headers({ Origin: origin, "Content-Type": "application/json" });
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) requestHeaders.set(name, value);
  }
  return new Request(endpoint, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSessionAuth).mockResolvedValue({ userId: "user_owned" });
  vi.mocked(getSessionMeta).mockResolvedValue({ id: "sess_owned" } as NonNullable<Awaited<ReturnType<typeof getSessionMeta>>>);
  vi.mocked(service.getIntegrationsStatus).mockResolvedValue(result());
  vi.mocked(service.unlinkSessionSupabase).mockResolvedValue(result());
  vi.mocked(service.unlinkSessionStripe).mockResolvedValue(result());
  vi.mocked(service.linkSessionStripe).mockResolvedValue(result());
  vi.mocked(service.linkSessionSupabaseManual).mockResolvedValue(result());
  vi.mocked(service.linkSessionSupabaseViaConnect).mockResolvedValue(result());
  vi.mocked(service.publishSession).mockResolvedValue(result());
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("session integration routes", () => {
  it("requires authentication and ownership before reading status", async () => {
    vi.mocked(requireSessionAuth).mockRejectedValueOnce(new UnauthenticatedError());
    expect((await getStatus(new Request(endpoint), context())).status).toBe(401);
    expect(getSessionMeta).not.toHaveBeenCalled();
    vi.mocked(getSessionMeta).mockRejectedValueOnce(new SessionAccessDeniedError());
    expect((await getStatus(new Request(endpoint), context())).status).toBe(403);
    expect(service.getIntegrationsStatus).not.toHaveBeenCalled();
  });

  it("requires ownership before mutating integrations", async () => {
    vi.mocked(getSessionMeta).mockRejectedValueOnce(new SessionAccessDeniedError());
    expect((await POST(post({ action: "unlink_stripe" }), context())).status).toBe(403);
    expect(service.unlinkSessionStripe).not.toHaveBeenCalled();
  });

  it("returns 404 for missing apps", async () => {
    vi.mocked(getSessionMeta).mockResolvedValue(null);
    expect((await getStatus(new Request(endpoint), context())).status).toBe(404);
    expect((await POST(post({ action: "publish" }), context())).status).toBe(404);
    expect(service.publishSession).not.toHaveBeenCalled();
  });

  it.each([
    { Origin: "https://attacker.example" },
    { Origin: "null" },
    { Origin: "" },
    { Origin: origin, "Sec-Fetch-Site": "cross-site" },
    { Origin: origin, "Sec-Fetch-Site": "same-site" },
  ])("rejects unsafe origins before processing a mutation: %j", async (headers) => {
    const response = await POST(post({ action: "unlink_stripe" }, headers), context());
    expect(response.status).toBe(403);
    expect(requireSessionAuth).not.toHaveBeenCalled();
    expect(service.unlinkSessionStripe).not.toHaveBeenCalled();
  });

  it("rejects a mutation without an Origin header", async () => {
    const request = post({ action: "publish" });
    request.headers.delete("origin");
    expect((await POST(request, context())).status).toBe(403);
    expect(service.publishSession).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    { action: secret },
    { action: "unlink_stripe", secretKey: secret },
    { action: "link_supabase_connect", projectRef: 42 },
    { action: "link_supabase_manual", projectUrl: "https://app.supabase.co", anonKey: {}, serviceRoleKey: secret },
    { action: "link_supabase_manual", projectUrl: "http://app.supabase.co", anonKey: "anon", serviceRoleKey: secret },
    { action: "link_supabase_manual", projectUrl: "https://app.supabase.co", anonKey: "anon", serviceRoleKey: secret, projectName: 1 },
    { action: "link_stripe", publishableKey: ["pk_test_abc"], secretKey: "sk_test_abc" },
    { action: "link_stripe", publishableKey: "pk_test_abc", secretKey: "sk_test_abc", webhookSecret: {} },
    { action: "link_stripe", publishableKey: "pk_live_abc", secretKey: "sk_test_abc" },
  ])("rejects malformed action payloads without echoing input: %j", async (body) => {
    const response = await POST(post(body), context());
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
    expect(service.linkSessionStripe).not.toHaveBeenCalled();
    expect(service.linkSessionSupabaseManual).not.toHaveBeenCalled();
    expect(service.linkSessionSupabaseViaConnect).not.toHaveBeenCalled();
    expect(service.unlinkSessionStripe).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const request = new Request(endpoint, { method: "POST", headers: { Origin: origin }, body: "{" });
    expect((await POST(request, context())).status).toBe(400);
  });

  it("passes only validated credentials and the authenticated owner to the service", async () => {
    const response = await POST(post({
      action: "link_supabase_manual",
      projectUrl: " https://app.supabase.co ",
      anonKey: " public-key ",
      serviceRoleKey: " private-key ",
    }), context());
    expect(response.status).toBe(200);
    expect(service.linkSessionSupabaseManual).toHaveBeenCalledWith({
      sessionId: "sess_owned", userId: "user_owned",
      projectUrl: "https://app.supabase.co", anonKey: "public-key", serviceRoleKey: "private-key",
      projectName: undefined,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["link_supabase_connect", { projectRef: "projectref" }, "linkSessionSupabaseViaConnect"],
    ["link_stripe", { publishableKey: "pk_test_abc", secretKey: "sk_test_abc", webhookSecret: "whsec_abc" }, "linkSessionStripe"],
    ["link_stripe", { publishableKey: "pk_live_abc", secretKey: "rk_live_abc" }, "linkSessionStripe"],
    ["unlink_supabase", {}, "unlinkSessionSupabase"],
    ["unlink_stripe", {}, "unlinkSessionStripe"],
    ["publish", {}, "publishSession"],
  ] as const)("dispatches the validated %s action", async (action, fields, method) => {
    expect((await POST(post({ action, ...fields }), context())).status).toBe(200);
    expect(service[method]).toHaveBeenCalledOnce();
  });

  it("scrubs stored errors and returns preview refresh state without its internal error", async () => {
    vi.mocked(service.unlinkSessionSupabase).mockResolvedValue({
      ...result(),
      supabase: { ...result().supabase, error: secret },
      stripe: { ...result().stripe, error: secret },
      deploy: { ...result().deploy, error: secret },
      preview: { status: "error", error: secret },
    });
    const response = await POST(post({ action: "unlink_supabase" }), context());
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).preview.status).toBe("error");
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([new Error(secret), new service.IntegrationError(secret, 502)])("does not expose or log an exception", async (error) => {
    vi.mocked(service.getIntegrationsStatus).mockRejectedValueOnce(error);
    const response = await getStatus(new Request(endpoint), context());
    expect(response.status).toBe(error instanceof service.IntegrationError ? 502 : 500);
    expect(await response.text()).not.toContain(secret);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    [new IntegrationProviderError("Supabase", 401), 400, "keys"],
    [new IntegrationProviderError("Stripe", 403), 400, "permissions"],
    [new IntegrationProviderError("Stripe", 504), 504, "respond in time"],
    [new SupabaseManagementError(secret, 429), 429, "Wait"],
    [new SupabaseManagementError(secret, 500), 502, "provider"],
  ] as const)("maps provider failures to a useful safe response", async (error, status, message) => {
    vi.mocked(service.getIntegrationsStatus).mockRejectedValueOnce(error);
    const response = await getStatus(new Request(endpoint), context());
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).toContain(message);
    expect(text).not.toContain(secret);
  });

  it("contains unexpected authentication failures", async () => {
    vi.mocked(requireSessionAuth).mockRejectedValueOnce(new Error(secret));
    const response = await getStatus(new Request(endpoint), context());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
  });
});

describe("Supabase project listing", () => {
  it("checks ownership before contacting the provider", async () => {
    vi.mocked(getSessionMeta).mockRejectedValueOnce(new SessionAccessDeniedError());
    const response = await getProjects(new Request(endpoint), context());
    expect(response.status).toBe(403);
    expect(service.listLinkedUserSupabaseProjects).not.toHaveBeenCalled();
  });

  it("returns only project display metadata", async () => {
    vi.mocked(service.listLinkedUserSupabaseProjects).mockResolvedValue([
      { id: "project", ref: "project", name: "My app", region: "us-east-1", status: "ACTIVE_HEALTHY", organizationId: "org", secret } as Awaited<ReturnType<typeof service.listLinkedUserSupabaseProjects>>[number],
    ]);
    const response = await getProjects(new Request(endpoint), context());
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secret);
    expect(service.listLinkedUserSupabaseProjects).toHaveBeenCalledWith("user_owned", "sess_owned");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not expose provider failures", async () => {
    vi.mocked(service.listLinkedUserSupabaseProjects).mockRejectedValueOnce(new Error(secret));
    const response = await getProjects(new Request(endpoint), context());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("Vercel Publish routes", () => {
  it("requires ownership before listing Vercel Teams", async () => {
    vi.mocked(getSessionMeta).mockRejectedValueOnce(new SessionAccessDeniedError());
    expect((await getTeams(new Request(endpoint), context())).status).toBe(403);
    expect(publishing.listPublishTeams).not.toHaveBeenCalled();
  });
  it("returns only Team display metadata", async () => {
    vi.mocked(publishing.listPublishTeams).mockResolvedValue([{ id: "team_own", name: "Owned", slug: "owned", secret } as Awaited<ReturnType<typeof publishing.listPublishTeams>>[number]]);
    const response = await getTeams(new Request(endpoint), context());
    expect(await response.json()).toEqual({ teams: [{ id: "team_own", name: "Owned", slug: "owned" }] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("accepts only an explicit Team ID and the authenticated owner", async () => {
    expect((await POST(post({ action: "select_vercel_team", teamId: "team_selected" }), context())).status).toBe(200);
    expect(publishing.choosePublishTeam).toHaveBeenCalledWith("sess_owned", "user_owned", "team_selected");
    expect((await POST(post({ action: "select_vercel_team", teamId: "team_selected", userId: "someone" }), context())).status).toBe(400);
    expect(publishing.choosePublishTeam).toHaveBeenCalledOnce();
  });
  it("reconciles an existing job through an authenticated same-origin mutation", async () => {
    expect((await POST(post({ action: "reconcile_vercel_publish" }), context())).status).toBe(200);
    expect(publishing.resumeVercelPublication).toHaveBeenCalledWith("sess_owned", "user_owned");
    expect((await POST(post({ action: "reconcile_vercel_publish" }, { Origin: "https://attacker.example" }), context())).status).toBe(403);
    expect(publishing.resumeVercelPublication).toHaveBeenCalledOnce();
  });
  it("starts Vercel authorization without accepting a client-selected subject", async () => {
    vi.mocked(service.startSessionConnection).mockResolvedValue({ authorizeUrl: "https://connect.vercel.com/authorize", cookieValue: "private-cookie" });
    const response = await start(post({ provider: "vercel" }), context());
    expect(response.status).toBe(200);
    expect(service.startSessionConnection).toHaveBeenCalledWith({ sessionId: "sess_owned", userId: "user_owned", provider: "vercel", origin });
    expect(response.headers.get("set-cookie")).toContain("bl_connect_vercel=");
    expect(await response.text()).not.toContain("private-cookie");
  });
  it("returns rejected Vercel consent to the owned app's Publish page", async () => {
    const response = await callback(new NextRequest(`${origin}/api/integrations/connect/callback?provider=vercel&error=denied&session=sess_owned`));
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("backend_provider")).toBe("vercel");
    expect(location.searchParams.get("session")).toBe("sess_owned");
    expect(service.completeSessionConnection).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("does not redirect a rejected callback to another owner's session", async () => {
    vi.mocked(getSessionMeta).mockRejectedValueOnce(new SessionAccessDeniedError());
    const response = await callback(new NextRequest(`${origin}/api/integrations/connect/callback?provider=vercel&error=denied&session=foreign`));
    expect(new URL(response.headers.get("location")!).searchParams.has("session")).toBe(false);
  });
});

describe("Connect authorization routes", () => {
  const callbackUrl = `${origin}/api/integrations/connect/callback?provider=supabase&state=state`;

  it("requires a same-origin POST to start authorization", async () => {
    expect((await start(post({ provider: "supabase" }, { Origin: "https://attacker.example" }), context())).status).toBe(403);
    expect(service.startSessionConnection).not.toHaveBeenCalled();
  });

  it("rejects client-selected identities and connector references", async () => {
    expect((await start(post({ provider: "stripe", connector: "stripe/other", userId: "other" }), context())).status).toBe(400);
    expect(service.startSessionConnection).not.toHaveBeenCalled();
  });

  it("keeps authorization state in a short-lived HttpOnly cookie", async () => {
    vi.mocked(service.startSessionConnection).mockResolvedValue({ authorizeUrl: "https://connect.vercel.com/authorize", cookieValue: "encrypted-state" });
    const response = await start(post({ provider: "supabase" }), context());
    expect(response.status).toBe(200);
    expect(service.startSessionConnection).toHaveBeenCalledWith({ sessionId: "sess_owned", userId: "user_owned", provider: "supabase", origin });
    expect(await response.text()).not.toContain("encrypted-state");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=600");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
  });

  it("requires callback authentication before verifying the grant", async () => {
    vi.mocked(requireSessionAuth).mockRejectedValueOnce(new UnauthenticatedError());
    const response = await callback(new NextRequest(callbackUrl));
    expect(service.completeSessionConnection).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${origin}/?backend=error`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("binds the callback to the authenticated user and returns only to the app", async () => {
    vi.mocked(service.completeSessionConnection).mockResolvedValueOnce({ sessionId: "sess_owned", provider: "supabase" });
    const response = await callback(new NextRequest(`${callbackUrl}&returnPath=https://attacker.example`, { headers: { Cookie: "bl_connect_supabase=encrypted-state" } }));
    expect(service.completeSessionConnection).toHaveBeenCalledWith({ state: "state", cookieValue: "encrypted-state", userId: "user_owned", provider: "supabase" });
    expect(response.headers.get("location")).toBe(`${origin}/?session=sess_owned&backend=supabase_connected`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each(["provider=unknown&state=state", `provider=stripe&error=${secret}`, "provider=supabase"]) ("contains rejected or malformed callbacks: %s", async (query) => {
    const response = await callback(new NextRequest(`${origin}/api/integrations/connect/callback?${query}`));
    expect(response.headers.get("location")).toBe(`${origin}/?backend=error`);
    expect(service.completeSessionConnection).not.toHaveBeenCalled();
  });

  it("does not expose Connect exceptions in redirects or logs", async () => {
    vi.mocked(service.completeSessionConnection).mockRejectedValueOnce(new Error(secret));
    const response = await callback(new NextRequest(callbackUrl));
    expect(response.headers.get("location")).toBe(`${origin}/?backend=error`);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
