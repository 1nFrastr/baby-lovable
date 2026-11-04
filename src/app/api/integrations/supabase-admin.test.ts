import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), session: vi.fn(), record: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/session/auth-context", () => ({
  requireSessionAuth: m.auth,
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SessionAccessDeniedError: class SessionAccessDeniedError extends Error {},
}));
vi.mock("@/lib/session/store", () => ({ getSessionMeta: m.session }));
vi.mock("@/lib/integrations/store", () => ({ readSessionIntegrations: m.record }));
vi.mock("@/lib/integrations/connect", () => ({ getAppConnectToken: m.token }));
vi.mock("@/lib/integrations/service", async () => ({
  IntegrationError: (await import("@/lib/integrations/errors")).IntegrationError,
}));

import { IntegrationError } from "@/lib/integrations/errors";
import { SUPABASE_APP_SCHEMA_QUERY } from "@/lib/integrations/supabase-admin";
import { SessionAccessDeniedError, UnauthenticatedError } from "@/lib/session/auth-context";
import { GET as getAuth, PATCH as patchAuth } from "../sessions/[sessionId]/integrations/supabase/auth/route";
import { GET as getSchema } from "../sessions/[sessionId]/integrations/supabase/schema/route";
import { POST as getRows } from "../sessions/[sessionId]/integrations/supabase/rows/route";
import { POST as getUsers } from "../sessions/[sessionId]/integrations/supabase/users/route";

const origin = "https://builder.example";
const endpoint = `${origin}/api/sessions/sess_owned/integrations/supabase`;
const secret = "HOST-ONLY-SECRET";
const context = () => ({ params: Promise.resolve({ sessionId: "sess_owned" }) });
const linked = {
  sessionId: "sess_owned", userId: "owner", supabaseStatus: "linked",
  supabaseProjectRef: "appdatabase", supabaseProjectUrl: "https://appdatabase.supabase.co",
  supabaseLinkMethod: "connect", supabaseConnectConnector: "oauth/supabase",
};
const config = {
  mailer_autoconfirm: false, disable_signup: false, external_anonymous_users_enabled: true,
  site_url: "https://app.example", uri_allow_list: "https://app.example/auth/callback, http://localhost:3000/**,",
  smtp_pass: secret, external_google_secret: secret, jwt_secret: secret,
};
const settings = {
  emailConfirmationRequired: true, signupEnabled: true, anonymousSignInsEnabled: true,
  siteUrl: "https://app.example", redirectUrls: ["https://app.example/auth/callback", "http://localhost:3000/**"],
};
let fetchMock: ReturnType<typeof vi.fn>;

function request(body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${endpoint}/auth`, {
    method: body === undefined ? "GET" : "PATCH",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function rowsRequest(body: unknown = { schema: "public", table: "notes" }, headers: Record<string, string> = {}) {
  return new Request(`${endpoint}/rows`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function usersRequest(body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request(`${endpoint}/users`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
const handlers = [
  ["auth GET", () => getAuth(request(), context())],
  ["auth PATCH", () => patchAuth(request({ signupEnabled: false }), context())],
  ["schema GET", () => getSchema(new Request(`${endpoint}/schema?projectRef=attacker&query=DELETE`), context())],
  ["rows POST", () => getRows(rowsRequest(), context())],
  ["users POST", () => getUsers(usersRequest(), context())],
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://hostmetadata.supabase.co");
  m.auth.mockResolvedValue({ userId: "owner" });
  m.session.mockResolvedValue({ id: "sess_owned", userId: "owner", runStatus: "idle" });
  m.record.mockResolvedValue({ ...linked });
  m.token.mockResolvedValue({ token: secret });
  fetchMock = vi.fn().mockImplementation(async () => Response.json(config));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function expectNoProviderAccess() {
  expect(m.token).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

async function safeError(response: Response, status: number, message?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(text).not.toContain(secret);
  if (message) expect(text).toContain(message);
  expect(console.info).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
}

describe.each(handlers)("Supabase admin access: %s", (_name, run) => {
  it("requires authentication before looking up an app", async () => {
    m.auth.mockRejectedValue(new UnauthenticatedError());
    await safeError(await run(), 401);
    expect(m.session).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
    expectNoProviderAccess();
  });

  it("checks ownership before reading integration metadata", async () => {
    m.session.mockRejectedValue(new SessionAccessDeniedError());
    await safeError(await run(), 403);
    expect(m.session).toHaveBeenCalledWith("sess_owned", { userId: "owner" });
    expect(m.record).not.toHaveBeenCalled();
    expectNoProviderAccess();
  });

  it("returns 404 for a missing app", async () => {
    m.session.mockResolvedValue(null);
    await safeError(await run(), 404);
    expectNoProviderAccess();
  });

  it("rejects a mismatched integration owner", async () => {
    m.record.mockResolvedValue({ ...linked, userId: "other" });
    await safeError(await run(), 403);
    expectNoProviderAccess();
  });

  it("requires a linked project", async () => {
    m.record.mockResolvedValue(null);
    await safeError(await run(), 409, "Link a Supabase project");
    expectNoProviderAccess();
  });

  it("gives manually linked projects an actionable administration error", async () => {
    m.record.mockResolvedValue({ ...linked, supabaseLinkMethod: "manual", supabaseConnectConnector: null });
    await safeError(await run(), 409, "Reconnect Supabase through Connect");
    expectNoProviderAccess();
  });

  it("rejects missing management connections without using runtime keys", async () => {
    m.record.mockResolvedValue({ ...linked, supabaseConnectConnector: null, supabaseSecrets: { serviceRoleKey: secret } });
    await safeError(await run(), 409, "Reconnect");
    expectNoProviderAccess();
  });

  it("blocks the host metadata project before obtaining credentials", async () => {
    m.record.mockResolvedValue({ ...linked, supabaseProjectRef: "hostmetadata", supabaseProjectUrl: "https://hostmetadata.supabase.co" });
    await safeError(await run(), 400, "separate Supabase project");
    expectNoProviderAccess();
  });

  it("rejects invalid stored project identifiers", async () => {
    m.record.mockResolvedValue({ ...linked, supabaseProjectRef: "appdatabase/../hostmetadata" });
    await safeError(await run(), 409, "Reconnect");
    expectNoProviderAccess();
  });

  it("contains expired Connect errors", async () => {
    m.token.mockRejectedValue(new IntegrationError(secret, 409, "connect_authorization_required"));
    await safeError(await run(), 409, "Reconnect the service");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[401, 400], [403, 400], [429, 429], [500, 502]] as const)("sanitizes provider HTTP %s", async (upstream, status) => {
    fetchMock.mockResolvedValue(new Response(secret, { status: upstream }));
    await safeError(await run(), status);
  });

  it("contains unexpected credential errors", async () => {
    m.token.mockRejectedValue(new Error(secret));
    await safeError(await run(), 500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Supabase authentication users", () => {
  const user = {
    id: "22222222-2222-4222-8222-222222222222", email: "person@example.com",
    email_confirmed_at: "2026-11-01T10:00:00Z", created_at: "2026-11-01T09:00:00Z",
    last_sign_in_at: "2026-11-02T12:00:00Z", is_anonymous: false,
    encrypted_password: secret, confirmation_token: secret, recovery_token: secret,
    raw_app_meta_data: { private: secret }, raw_user_meta_data: { private: secret },
  };

  it("returns only directory fields and uses bounded, deterministic read-only SQL", async () => {
    fetchMock.mockResolvedValue(Response.json([user]));
    const response = await getUsers(usersRequest(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ users: [{
      id: user.id, email: user.email, emailConfirmedAt: user.email_confirmed_at,
      createdAt: user.created_at, lastSignInAt: user.last_sign_in_at, isAnonymous: false,
    }], hasMore: false, offset: 0, pageSize: 25 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.supabase.com/v1/projects/appdatabase/database/query");
    const body = JSON.parse(init.body);
    expect(body.read_only).toBe(true);
    expect(body.query).toContain("WHERE app_user.deleted_at IS NULL");
    expect(body.query).toContain("ORDER BY app_user.created_at DESC NULLS LAST, app_user.id ASC LIMIT 26 OFFSET 0");
    expect(body.query).not.toMatch(/SELECT\s+\*|encrypted_password|token|meta_data/i);
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("fetches a lookahead record and returns only the requested page", async () => {
    fetchMock.mockResolvedValue(Response.json([user, { ...user, id: "33333333-3333-4333-8333-333333333333" }]));
    const response = await getUsers(usersRequest({ offset: 2, pageSize: 1 }), context());
    expect(await response.json()).toMatchObject({ users: [{ id: user.id }], hasMore: true, offset: 2, pageSize: 1 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toContain("LIMIT 2 OFFSET 2");
  });

  it("represents anonymous users and never-signed-in accounts without inventing verification", async () => {
    fetchMock.mockResolvedValue(Response.json([{ ...user, email: null, email_confirmed_at: null, created_at: null, last_sign_in_at: null, is_anonymous: true }]));
    const response = await getUsers(usersRequest(), context());
    expect(await response.json()).toMatchObject({ users: [{ email: null, emailConfirmedAt: null, createdAt: null, lastSignInAt: null, isAnonymous: true }] });
  });

  it.each([null, [], { search: "a".repeat(201) }, { search: "bad\0search" }, { offset: -1 }, { offset: 0.5 }, { offset: 100_001 }, { pageSize: 0 }, { pageSize: 101 }, { pageSize: "25" }, { query: "SELECT * FROM auth.users" }, { projectRef: "other" }, { schema: "auth" }])("rejects invalid user queries before obtaining provider credentials: %j", async (body) => {
    await safeError(await getUsers(usersRequest(body), context()), 400);
    expectNoProviderAccess();
  });

  it.each<Record<string, string>>([{ Origin: "https://other.example" }, { Origin: "" }, { "sec-fetch-site": "cross-site" }])("rejects cross-origin user searches: %j", async (headers) => {
    await safeError(await getUsers(usersRequest({}, headers), context()), 403);
    expect(m.auth).not.toHaveBeenCalled();
    expectNoProviderAccess();
  });

  it("returns an empty result and strips surrounding search whitespace", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    const response = await getUsers(usersRequest({ search: "  person@example.com  " }), context());
    expect(await response.json()).toEqual({ users: [], hasMore: false, offset: 0, pageSize: 25 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toContain("%person@example.com%");
  });

  it.each([[{ id: user.id }], [{ ...user, is_anonymous: null }], Array.from({ length: 27 }, () => user), { users: [user] }])("rejects malformed provider responses without leaking their contents", async (result) => {
    fetchMock.mockResolvedValue(Response.json(result));
    await safeError(await getUsers(usersRequest(), context()), 502);
  });

  it("returns an actionable paused-project error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(secret, { status: 400 })).mockResolvedValueOnce(Response.json({ status: "INACTIVE" }));
    await safeError(await getUsers(usersRequest(), context()), 409, "paused");
  });

  it.skipIf(process.env.BABY_TEST_LOCAL_POSTGRES !== "1")("executes literal email/user-ID searches safely in local PostgreSQL without exposing Auth secrets", async () => {
    const email = "auth-browser-'quote%_\\slash@example.test";
    fetchMock.mockResolvedValue(Response.json([]));
    await getUsers(usersRequest({ search: email, pageSize: 1 }), context());
    const emailQuery = JSON.parse(fetchMock.mock.calls[0][1].body).query;
    await getUsers(usersRequest({ search: "44444444-4444-4444-8444-444444444444", pageSize: 1 }), context());
    const idQuery = JSON.parse(fetchMock.mock.calls[1][1].body).query;
    const literal = (value: string) => `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
    const sql = `BEGIN;
      INSERT INTO auth.users (id, email, encrypted_password, confirmation_token, created_at, is_anonymous)
      VALUES ('44444444-4444-4444-8444-444444444444', ${literal(email)}, 'AUTH-PRIVATE-FIXTURE', 'AUTH-PRIVATE-FIXTURE', now(), false);
      SELECT coalesce(json_agg(entry), '[]') FROM (${emailQuery}) entry;
      SELECT coalesce(json_agg(entry), '[]') FROM (${idQuery}) entry;
      ROLLBACK;`;
    const output = execFileSync("docker", ["exec", "-i", "supabase_db_workflow-agent-app", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t"], { input: sql, encoding: "utf8" });
    expect(output.match(/44444444-4444-4444-8444-444444444444/g)).toHaveLength(2);
    expect(output).not.toContain("AUTH-PRIVATE-FIXTURE");
    expect(output).not.toContain("encrypted_password");
  });
});

describe("Supabase authentication settings", () => {
  it("maps and whitelists the config response using only this app's Management credential", async () => {
    const response = await getAuth(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(m.record).toHaveBeenCalledWith("sess_owned", false);
    expect(m.token).toHaveBeenCalledWith({ connector: "oauth/supabase", subject: "user" }, "owner", "sess_owned", true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.supabase.com/v1/projects/appdatabase/config/auth");
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.headers.get("Authorization")).toBe(`Bearer ${secret}`);
  });

  it("maps inverse boolean fields in both directions and handles an empty allow list", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...config, mailer_autoconfirm: true, disable_signup: true, external_anonymous_users_enabled: false, uri_allow_list: null }));
    const response = await getAuth(request(), context());
    expect(await response.json()).toEqual({ settings: { ...settings, emailConfirmationRequired: false, signupEnabled: false, anonymousSignInsEnabled: false, redirectUrls: [] } });
  });

  it.each([true, false])("maps a complete PATCH with boolean %s and reads back authoritative settings", async (value) => {
    const body = {
      emailConfirmationRequired: value, signupEnabled: value, anonymousSignInsEnabled: value,
      siteUrl: "http://localhost:3000", redirectUrls: ["http://localhost:3000/**", "https://*.example.com/auth/**"],
    };
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await patchAuth(request(body), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      mailer_autoconfirm: !value, disable_signup: !value, external_anonymous_users_enabled: value,
      site_url: body.siteUrl, uri_allow_list: body.redirectUrls.join(","),
    });
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
  });

  it("sends only supplied fields and supports clearing redirect URLs", async () => {
    const response = await patchAuth(request({ redirectUrls: [] }), context());
    expect(response.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ uri_allow_list: "" });
  });

  it.each([
    null, [], {}, { settings: { signupEnabled: true } },
    { projectRef: "hostmetadata", signupEnabled: false },
    { mailer_autoconfirm: true }, { smtp_pass: secret },
    { signupEnabled: "false" }, { emailConfirmationRequired: 1 }, { anonymousSignInsEnabled: null },
    { siteUrl: "" }, { siteUrl: "javascript:alert(1)" }, { siteUrl: "https://user:password@example.com" },
    { siteUrl: "https://*.example.com" }, { siteUrl: "https://app.example/\ncallback" },
    { redirectUrls: "https://app.example" }, { redirectUrls: [42] }, { redirectUrls: ["/callback"] },
    { redirectUrls: ["https://app.example/one,https://attacker.example"] },
    { redirectUrls: Array.from({ length: 101 }, () => "https://app.example") },
  ])("rejects invalid settings without echoing them: %j", async (body) => {
    await safeError(await patchAuth(request(body), context()), 400, "supported authentication setting");
    expectNoProviderAccess();
  });

  it("rejects malformed JSON", async () => {
    const req = new Request(`${endpoint}/auth`, { method: "PATCH", headers: { Origin: origin }, body: "{" });
    await safeError(await patchAuth(req, context()), 400);
    expectNoProviderAccess();
  });

  it.each([
    { Origin: "https://attacker.example" }, { Origin: "null" }, { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
  ] as Record<string, string>[])("requires a safe mutation origin: %j", async (headers) => {
    await safeError(await patchAuth(request({ signupEnabled: false }, headers), context()), 403);
    expect(m.auth).not.toHaveBeenCalled();
    expectNoProviderAccess();
  });

  it("rejects a PATCH without Origin", async () => {
    const req = request({ signupEnabled: false });
    req.headers.delete("Origin");
    await safeError(await patchAuth(req, context()), 403);
    expectNoProviderAccess();
  });

  it("blocks mutations while the agent is changing the app", async () => {
    m.session.mockResolvedValue({ userId: "owner", runStatus: "running" });
    await safeError(await patchAuth(request({ signupEnabled: false }), context()), 409, "Wait for the current app changes");
    expectNoProviderAccess();
  });

  it("fails safely on incomplete provider configuration instead of inventing settings", async () => {
    fetchMock.mockResolvedValue(Response.json({ smtp_pass: secret }));
    await safeError(await getAuth(request(), context()), 502);
  });
});

describe("Supabase application schema", () => {
  const column = {
    schema: "public", name: "notes", rls_enabled: true, column_name: "id", data_type: "uuid",
    nullable: false, default_value: "gen_random_uuid()", primary_key: true,
    reference_schema: null, reference_table: null, reference_column: null,
  };

  it("uses fixed read-only catalog SQL, ignores client SQL/project refs, and groups safe table metadata", async () => {
    fetchMock.mockResolvedValue(Response.json([
      { ...column, unrequested_secret: secret },
      { ...column, column_name: "owner_id", default_value: null, primary_key: false, reference_schema: "auth", reference_table: "users", reference_column: "id" },
      { ...column, schema: "custom", rls_enabled: false, column_name: "title", data_type: "text", nullable: true, default_value: null, primary_key: false },
      { ...column, name: "empty_table", column_name: null, data_type: null, nullable: null, default_value: null, primary_key: false },
    ]));
    const response = await getSchema(new Request(`${endpoint}/schema?projectRef=hostmetadata&query=DROP%20TABLE`), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ tables: [
      { schema: "public", name: "notes", rlsEnabled: true, columns: [
        { name: "id", dataType: "uuid", nullable: false, defaultValue: "gen_random_uuid()", primaryKey: true, references: null },
        { name: "owner_id", dataType: "uuid", nullable: false, defaultValue: null, primaryKey: false, references: { schema: "auth", table: "users", column: "id" } },
      ] },
      { schema: "custom", name: "notes", rlsEnabled: false, columns: [
        { name: "title", dataType: "text", nullable: true, defaultValue: null, primaryKey: false, references: null },
      ] },
      { schema: "public", name: "empty_table", rlsEnabled: true, columns: [] },
    ] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.supabase.com/v1/projects/appdatabase/database/query");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ query: SUPABASE_APP_SCHEMA_QUERY, read_only: true });
    expect(SUPABASE_APP_SCHEMA_QUERY).toContain("fk.confkey[pg_catalog.array_position(fk.conkey, attr.attnum)]");
    expect(SUPABASE_APP_SCHEMA_QUERY).not.toContain("SELECT *");
  });

  it("reports paused databases with an actionable 409 after a query rejection", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(secret, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ status: "INACTIVE", database: { password: secret } }));
    await safeError(await getSchema(new Request(`${endpoint}/schema`), context()), 409, "Resume the project in Supabase");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.supabase.com/v1/projects/appdatabase");
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
  });

  it.each(["ACTIVE_HEALTHY", "ACTIVE_UNHEALTHY"])("preserves sanitized query errors for project status %s", async (status) => {
    fetchMock
      .mockResolvedValueOnce(new Response(secret, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ status }));
    await safeError(await getSchema(new Request(`${endpoint}/schema`), context()), 502);
  });

  it("preserves the query failure when the diagnostic lifecycle lookup fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(secret, { status: 400 }))
      .mockResolvedValueOnce(new Response(secret, { status: 403 }));
    await safeError(await getSchema(new Request(`${endpoint}/schema`), context()), 502);
  });

  it("returns an empty table list for an empty app database", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    expect(await (await getSchema(new Request(`${endpoint}/schema`), context())).json()).toEqual({ tables: [] });
  });

  it.each([{ data: [] }, [{ ...column, nullable: "YES" }], [{ ...column, data_type: null }]])("rejects malformed metadata without exposing provider data: %j", async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await safeError(await getSchema(new Request(`${endpoint}/schema`), context()), 502);
  });
});

const rowColumn = {
  schema: "public", name: "notes", rls_enabled: true, column_name: "id", data_type: "uuid",
  nullable: false, default_value: null, primary_key: true,
  reference_schema: null, reference_table: null, reference_column: null,
};

function mockRows(columns = [rowColumn], rows: Record<string, unknown>[] = []) {
  fetchMock.mockResolvedValueOnce(Response.json(columns));
  fetchMock.mockResolvedValueOnce(Response.json(rows.map((row) => ({ row }))));
}

function dataQuery(): string {
  const body = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(body.read_only).toBe(true);
  return body.query;
}

describe("Supabase table data", () => {
  it("defaults to a bounded page ordered by primary key and fetches one extra row", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({ id: String(index), title: `Note ${index}` }));
    mockRows([rowColumn], rows);
    const response = await getRows(rowsRequest(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ rows: rows.slice(0, 25), hasMore: true, offset: 0, pageSize: 25, orderBy: [{ column: "id", direction: "asc" }] });
    expect(dataQuery()).toContain('FROM "public"."notes" AS app_row ORDER BY to_jsonb(app_row."id") ASC NULLS LAST, app_row.tableoid ASC, app_row.ctid ASC LIMIT 26 OFFSET 0');
    expect(fetchMock.mock.calls[0][1].body).toContain('"read_only":true');
    expect(m.token).toHaveBeenCalledOnce();
  });

  it("supports explicit paging and descending order with PK tiebreakers", async () => {
    mockRows([rowColumn, { ...rowColumn, column_name: "title", data_type: "text", primary_key: false }], [{ id: "abc", title: "Z" }]);
    const response = await getRows(rowsRequest({ schema: "public", table: "notes", offset: 100, pageSize: 50, sort: { column: "title", direction: "desc" } }), context());
    expect(await response.json()).toEqual({ rows: [{ id: "abc", title: "Z" }], hasMore: false, offset: 100, pageSize: 50, orderBy: [{ column: "title", direction: "desc" }, { column: "id", direction: "asc" }] });
    expect(dataQuery()).toContain('to_jsonb(app_row."title") DESC NULLS LAST, to_jsonb(app_row."id") ASC NULLS LAST');
    expect(dataQuery()).toContain("LIMIT 51 OFFSET 100");
  });

  it("preserves bigint and numeric precision as text and supports JSON values", async () => {
    mockRows([
      { ...rowColumn, data_type: "bigint" },
      { ...rowColumn, column_name: "amount", data_type: "numeric(38,18)", primary_key: false },
      { ...rowColumn, column_name: "payload", data_type: "jsonb", primary_key: false },
    ], [{ id: "9223372036854775807", amount: "12345678901234567890.123456789012345678", payload: { hello: [1, true] } }]);
    const response = await getRows(rowsRequest(), context());
    expect((await response.json()).rows[0]).toEqual({ id: "9223372036854775807", amount: "12345678901234567890.123456789012345678", payload: { hello: [1, true] } });
    expect(dataQuery()).toContain('to_jsonb(app_row."id"::text)');
    expect(dataQuery()).toContain('to_jsonb(app_row."amount"::text)');
    expect(dataQuery()).toContain('to_jsonb(app_row."payload")');
  });

  it("escapes quoted identifiers from verified metadata and filter literals independently", async () => {
    const schema = 'a"schema'; const table = "table'; DROP TABLE secrets;--"; const column = 'odd"column';
    mockRows([{ ...rowColumn, schema, name: table, column_name: column }]);
    const response = await getRows(rowsRequest({ schema, table, filter: { column, operator: "equals", value: "' OR true; --\\" } }), context());
    expect(response.status).toBe(200);
    expect(dataQuery()).toContain('FROM "a""schema"."table\'; DROP TABLE secrets;--" AS app_row');
    expect(dataQuery()).toContain('app_row."odd""column"::text = E\'\'\' OR true; --\\\\\'');
  });

  it.each([
    ["contains", "50%_\\done", "ILIKE E'%50\\\\%\\\\_\\\\\\\\done%' ESCAPE E'\\\\'"],
    ["equals", "hello", "= E'hello'"],
    ["not_equals", "hello", "<> E'hello'"],
    ["is_null", undefined, "IS NULL"],
    ["is_not_null", undefined, "IS NOT NULL"],
  ] as const)("builds the %s filter", async (operator, value, sql) => {
    mockRows();
    const response = await getRows(rowsRequest({ schema: "public", table: "notes", filter: { column: "id", operator, ...(value === undefined ? {} : { value }) } }), context());
    expect(response.status).toBe(200);
    expect(dataQuery()).toContain(`app_row."id"${operator.startsWith("is_") ? " " : "::text "}${sql}`);
  });

  it("uses physical tiebreakers for tables without primary keys", async () => {
    mockRows([{ ...rowColumn, primary_key: false }]);
    const response = await getRows(rowsRequest(), context());
    expect((await response.json()).orderBy).toEqual([]);
    expect(dataQuery()).toContain("ORDER BY app_row.tableoid ASC, app_row.ctid ASC");
  });

  it.each([
    null, [], {}, { schema: "public", table: "notes", query: "DELETE" },
    { schema: "public", table: "notes", projectRef: "hostmetadata" },
    { schema: "", table: "notes" }, { schema: "public", table: "notes\0" },
    { schema: "public", table: "notes", offset: -1 }, { schema: "public", table: "notes", offset: 100001 },
    { schema: "public", table: "notes", offset: 1.5 }, { schema: "public", table: "notes", offset: "1" },
    { schema: "public", table: "notes", pageSize: 0 }, { schema: "public", table: "notes", pageSize: 101 },
    { schema: "public", table: "notes", sort: { column: "id", direction: "asc; DELETE" } },
    { schema: "public", table: "notes", sort: { column: "id", direction: "asc", sql: "DELETE" } },
    { schema: "public", table: "notes", filter: { column: "id", operator: "equals" } },
    { schema: "public", table: "notes", filter: { column: "id", operator: "is_null", value: "x" } },
    { schema: "public", table: "notes", filter: { column: "id", operator: "equals", value: "x".repeat(2001) } },
    { schema: "public", table: "notes", filter: { column: "id", operator: "equals", value: "\0" } },
  ])("rejects invalid input before obtaining credentials: %j", async (body) => {
    await safeError(await getRows(rowsRequest(body), context()), 400, "valid columns");
    expectNoProviderAccess();
  });

  it.each([
    { schema: "auth", table: "users" },
    { schema: "public", table: 'notes"; DROP TABLE notes;--' },
    { schema: "public", table: "notes", sort: { column: 'id"; DELETE', direction: "asc" } },
    { schema: "public", table: "notes", filter: { column: "missing", operator: "is_null" } },
  ])("allows only tables and columns present in app metadata: %j", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json([rowColumn]));
    await safeError(await getRows(rowsRequest(body), context()), 400, "valid columns");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("contains paused database errors on the data query", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([rowColumn]));
    fetchMock.mockResolvedValueOnce(new Response(secret, { status: 400 }));
    fetchMock.mockResolvedValueOnce(Response.json({ status: "INACTIVE" }));
    await safeError(await getRows(rowsRequest(), context()), 409, "Resume the project");
  });

  it.each([{}, [{ row: null }], [{ row: [] }], [{ wrong: { id: "x" } }]])("rejects malformed provider rows: %j", async (result) => {
    fetchMock.mockResolvedValueOnce(Response.json([rowColumn]));
    fetchMock.mockResolvedValueOnce(Response.json(result));
    await safeError(await getRows(rowsRequest(), context()), 502);
  });

  it("requires same-origin requests before reading authentication", async () => {
    await safeError(await getRows(rowsRequest(undefined, { Origin: "https://attacker.example" }), context()), 403);
    expect(m.auth).not.toHaveBeenCalled();
    expectNoProviderAccess();
  });

  it("rejects malformed JSON", async () => {
    const req = new Request(`${endpoint}/rows`, { method: "POST", headers: { Origin: origin }, body: "{" });
    await safeError(await getRows(req, context()), 400);
    expectNoProviderAccess();
  });

  it.skipIf(process.env.BABY_TEST_LOCAL_POSTGRES !== "1")("executes generated paging/filter SQL in a rolled-back local PostgreSQL fixture", async () => {
    mockRows([
      { ...rowColumn, schema: "baby_rows_test", data_type: "bigint" },
      { ...rowColumn, schema: "baby_rows_test", column_name: "amount", data_type: "numeric(38,18)", primary_key: false },
      { ...rowColumn, schema: "baby_rows_test", column_name: "payload", data_type: "jsonb", primary_key: false },
      { ...rowColumn, schema: "baby_rows_test", column_name: "title", data_type: "text", primary_key: false },
    ]);
    const response = await getRows(rowsRequest({ schema: "baby_rows_test", table: "notes", pageSize: 1, sort: { column: "amount", direction: "desc" }, filter: { column: "title", operator: "contains", value: "50%_\\done" } }), context());
    expect(response.status).toBe(200);
    const sql = `BEGIN; CREATE SCHEMA baby_rows_test; CREATE TABLE baby_rows_test.notes (id bigint PRIMARY KEY, amount numeric(38,18), payload jsonb, title text); INSERT INTO baby_rows_test.notes VALUES (9223372036854775807, 12345678901234567890.123456789012345678, jsonb_build_object('enabled', true), E'50%_\\\\done'); ${dataQuery()}; ROLLBACK;`;
    const output = execFileSync("docker", ["exec", "-i", "supabase_db_workflow-agent-app", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t"], { input: sql, encoding: "utf8" });
    expect(output).toContain('"id": "9223372036854775807"');
    expect(output).toContain('"amount": "12345678901234567890.123456789012345678"');
  });
});
