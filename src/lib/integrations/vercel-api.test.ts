import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { IntegrationError } from "./errors";
import {
  createVercelDeployment,
  createVercelProject,
  findVercelDeployment,
  getVercelBuildLogs,
  getVercelDeployment,
  getVercelProject,
  getVercelProjectEnv,
  listVercelTeams,
  uploadVercelFiles,
  VercelApiError,
  type VercelDeploymentInput,
} from "./vercel-api";

const TOKEN = "vercel-host-secret-token";
const TEAM = "team_test";
const deployment = { id: "dpl_test", readyState: "READY", url: "app-abc-team.vercel.app" };
const project = {
  id: "prj_test", name: "app", createdAt: 123,
  targets: { production: { alias: ["stable-domain.vercel.app"], url: deployment.url } },
};
const input: VercelDeploymentInput = {
  projectId: "prj_test", name: "app", files: [],
  env: { DATABASE_URL: "private-db-url", NEXT_PUBLIC_API_URL: "https://api.example.com" },
  jobId: "job_test", sourceSha: "abc123",
};

function mockResponses(...responses: Response[]) {
  const mock = vi.fn();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function call(mock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(url), init, headers: new Headers(init.headers) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Vercel teams and transport", () => {
  it("lists all team pages, deduplicates boundary entries, and keeps auth only in headers", async () => {
    const first = { id: "team_a", slug: "a", name: "A" };
    const second = { id: "team_b", slug: "b", name: "B" };
    const mock = mockResponses(
      Response.json({ teams: [first], pagination: { next: 100 } }),
      Response.json({ teams: [first, second], pagination: { next: null } }),
    );
    await expect(listVercelTeams(TOKEN)).resolves.toEqual([first, second]);
    const { url, init, headers } = call(mock);
    expect(url.origin + url.pathname).toBe("https://api.vercel.com/v2/teams");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(call(mock, 1).url.searchParams.get("until")).toBe("100");
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(url.toString()).not.toContain(TOKEN);
    expect(init).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects pagination loops instead of returning partial teams", async () => {
    const mock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ teams: [], pagination: { next: 7 } })));
    vi.stubGlobal("fetch", mock);
    await expect(listVercelTeams(TOKEN)).rejects.toThrow("invalid pagination cursor");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("bounds otherwise valid pagination at 100 pages", async () => {
    let cursor = 1000;
    const mock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ teams: [], pagination: { next: cursor-- } })));
    vi.stubGlobal("fetch", mock);
    await expect(listVercelTeams(TOKEN)).rejects.toThrow("pagination limit exceeded");
    expect(mock).toHaveBeenCalledTimes(100);
  });

  it("does not silently normalize malformed success data to an empty list", async () => {
    mockResponses(Response.json({ teams: "invalid" }));
    await expect(listVercelTeams(TOKEN)).rejects.toBeInstanceOf(VercelApiError);
  });

  it.each(["", "\r\nBearer stolen"])("rejects invalid access tokens before fetching", async (token) => {
    const mock = mockResponses();
    await expect(listVercelTeams(token)).rejects.toMatchObject({ status: 400, uncertain: false });
    expect(mock).not.toHaveBeenCalled();
  });

  it("requires explicit team scope", async () => {
    const mock = mockResponses();
    await expect(getVercelProject(TOKEN, "", "prj_test")).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("uses encoded resource identifiers without changing the API origin", async () => {
    const mock = mockResponses(Response.json(deployment));
    await getVercelDeployment(TOKEN, "team&other=1", "https://evil.example/a?b=1");
    const { url } = call(mock);
    expect(url.origin).toBe("https://api.vercel.com");
    expect(url.pathname).toBe("/v13/deployments/https%3A%2F%2Fevil.example%2Fa%3Fb%3D1");
    expect(url.searchParams.get("teamId")).toBe("team&other=1");
    expect([...url.searchParams.keys()]).toEqual(["teamId"]);
  });
});

describe("Vercel project stable production domain", () => {
  it("creates a Next.js project with the requested team", async () => {
    const mock = mockResponses(Response.json(project));
    await expect(createVercelProject(TOKEN, TEAM, "app")).resolves.toEqual({
      id: "prj_test", name: "app", productionDomain: "stable-domain.vercel.app", createdAt: 123,
    });
    const { url, init } = call(mock);
    expect(url.pathname).toBe("/v11/projects");
    expect(url.searchParams.get("teamId")).toBe(TEAM);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "app", framework: "nextjs" });
  });

  it("reads by name, with targets.production.alias taking priority over the deployment URL", async () => {
    const mock = mockResponses(Response.json(project));
    const result = await getVercelProject(TOKEN, TEAM, "app");
    expect(result.productionDomain).toBe("stable-domain.vercel.app");
    expect(result.productionDomain).not.toBe(deployment.url);
    expect(call(mock).url.pathname).toBe("/v9/projects/app");
  });

  it("recognizes the actual project alias domain objects and excludes preview and redirect entries", async () => {
    mockResponses(Response.json({ id: "prj_test", name: "app", alias: [
      { domain: "branch.vercel.app", environment: "preview", target: "PREVIEW" },
      { domain: "redirect.example.com", environment: "production", redirect: "www.example.com" },
      { domain: "feature.example.com", environment: "production", gitBranch: "feature" },
      { domain: "www.example.com", environment: "production", target: "PRODUCTION" },
    ] }));
    await expect(getVercelProject(TOKEN, TEAM, "prj_test")).resolves.toMatchObject({ productionDomain: "www.example.com" });
  });

  it("uses the explicit project domains endpoint before the first deployment", async () => {
    const mock = mockResponses(
      Response.json({ id: "prj_test", name: "app", targets: {}, alias: [] }),
      Response.json({ domains: [{ name: "app-suffix.vercel.app", verified: true }], pagination: { next: null } }),
    );
    await expect(getVercelProject(TOKEN, TEAM, "prj_test")).resolves.toMatchObject({ productionDomain: "app-suffix.vercel.app" });
    const { url } = call(mock, 1);
    expect(url.pathname).toBe("/v9/projects/prj_test/domains");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ teamId: TEAM, production: "true", target: "production", redirects: "false", verified: "true" });
  });

  it("paginates domains and excludes branch, unverified, custom-env, and redirect domains", async () => {
    mockResponses(
      Response.json({ id: "prj_test", name: "app" }),
      Response.json({ domains: [
        { name: "unverified.example.com", verified: false },
        { name: "branch.example.com", gitBranch: "feature" },
        { name: "staging.example.com", customEnvironmentId: "env_staging" },
        { name: "redirect.example.com", redirect: "elsewhere.example.com" },
      ], pagination: { next: 1 } }),
      Response.json({ domains: [{ name: "app-real.vercel.app", verified: true }], pagination: { next: null } }),
    );
    await expect(getVercelProject(TOKEN, TEAM, "prj_test")).resolves.toMatchObject({ productionDomain: "app-real.vercel.app" });
  });

  it("never guesses a domain or uses targets.production.url when no aliases exist", async () => {
    mockResponses(
      Response.json({ id: "prj_test", name: "app", targets: { production: { alias: [deployment.url], url: deployment.url } } }),
      Response.json({ domains: [], pagination: { next: null } }),
    );
    await expect(getVercelProject(TOKEN, TEAM, "prj_test")).resolves.toMatchObject({ productionDomain: "" });
  });

  it("preserves 404 for deterministic-name project reconciliation", async () => {
    mockResponses(Response.json({ error: { message: TOKEN } }, { status: 404 }));
    await expect(getVercelProject(TOKEN, TEAM, "missing")).rejects.toMatchObject({ status: 404, uncertain: false });
  });

  it("marks a failed post-create domain lookup as uncertain", async () => {
    mockResponses(Response.json({ id: "prj_test", name: "app" }), new Response(null, { status: 403 }));
    await expect(createVercelProject(TOKEN, TEAM, "app")).rejects.toMatchObject({ status: 403, uncertain: true });
  });
});

describe("Vercel files and deployments", () => {
  it("uploads binary bytes with SHA1 and byte-size headers, preserving paths and modes", async () => {
    const mock = mockResponses(new Response(null, { status: 200 }), new Response(null, { status: 200 }));
    const bytes = Buffer.from([0, 255, 10]);
    const sha = createHash("sha1").update(bytes).digest("hex");
    await expect(uploadVercelFiles(TOKEN, TEAM, [
      { path: "public/image.bin", content: bytes, mode: 0o100644 },
      { path: "public/copy.bin", content: bytes },
      { path: "empty", content: Buffer.alloc(0) },
    ])).resolves.toEqual([
      { file: "public/image.bin", sha, size: 3, mode: 0o100644 },
      { file: "public/copy.bin", sha, size: 3 },
      { file: "empty", sha: createHash("sha1").update("").digest("hex"), size: 0 },
    ]);
    expect(mock).toHaveBeenCalledTimes(2);
    const { url, init, headers } = call(mock);
    expect(url.pathname).toBe("/v2/files");
    expect(url.searchParams.get("teamId")).toBe(TEAM);
    expect(init.method).toBe("POST");
    expect(init.body).toEqual(new Uint8Array(bytes));
    expect(headers.get("x-vercel-digest")).toBe(sha);
    expect(headers.get("x-vercel-size")).toBe("3");
    expect(headers.get("Content-Length")).toBe("3");
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("creates production deployments with isolated build/runtime env and reconciliation metadata", async () => {
    const mock = mockResponses(Response.json({ ...deployment, readyState: "QUEUED", env: { secret: TOKEN } }));
    const files = [{ file: "package.json", sha: "a".repeat(40), size: 12, mode: 0o100644 }];
    await expect(createVercelDeployment(TOKEN, TEAM, { ...input, files })).resolves.toEqual({
      id: deployment.id, state: "QUEUED", url: deployment.url, error: null,
    });
    const { url, init } = call(mock);
    expect(url.pathname).toBe("/v13/deployments");
    expect(url.searchParams.get("teamId")).toBe(TEAM);
    expect(JSON.parse(init.body as string)).toEqual({
      name: "app", project: "prj_test", target: "production", projectSettings: { framework: "nextjs" },
      files, env: input.env, build: { env: input.env }, meta: { jobId: "job_test", sourceSha: "abc123" },
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("maps deployment errors without leaking provider error messages or arbitrary fields", async () => {
    mockResponses(Response.json({ id: "dpl_failed", readyState: "ERROR", errorMessage: `secret ${TOKEN}`, env: input.env }));
    await expect(getVercelDeployment(TOKEN, TEAM, "dpl_failed")).resolves.toEqual({
      id: "dpl_failed", state: "ERROR", url: null, error: "Vercel deployment failed. Check the build logs for details.",
    });
  });

  it("finds an uncertain creation by exact meta.jobId across pages, mapping list uid/state", async () => {
    const mock = mockResponses(
      Response.json({ deployments: [{ ...deployment, meta: { jobId: "other" } }], pagination: { next: 50 } }),
      Response.json({ deployments: [
        { uid: "wrong-project", state: "READY", projectId: "prj_other", meta: { jobId: input.jobId } },
        { uid: "dpl_found", state: "BUILDING", url: deployment.url, meta: { jobId: input.jobId } },
      ], pagination: { next: null } }),
    );
    await expect(findVercelDeployment(TOKEN, TEAM, input.projectId, input.jobId)).resolves.toEqual({
      id: "dpl_found", state: "BUILDING", url: deployment.url, error: null,
    });
    expect(call(mock).url.pathname).toBe("/v7/deployments");
    expect(call(mock).url.searchParams.get("projectId")).toBe(input.projectId);
    expect(call(mock, 1).url.searchParams.get("until")).toBe("50");
  });

  it("returns null only after an exhausted deployment scan", async () => {
    mockResponses(Response.json({ deployments: [], pagination: { next: null } }));
    await expect(findVercelDeployment(TOKEN, TEAM, input.projectId, input.jobId)).resolves.toBeNull();
  });
});

describe("Vercel safe errors and uncertainty", () => {
  it.each([500, 502, 503, 504, 408])("marks mutation status %i uncertain and never retries", async (status) => {
    const mock = mockResponses(Response.json({ error: { message: `Bearer ${TOKEN} ${input.env.DATABASE_URL}` } }, { status }));
    const error = await createVercelDeployment(TOKEN, TEAM, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error).toMatchObject({ name: "VercelApiError", status, uncertain: true });
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(input.env.DATABASE_URL);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 409, 429])("marks mutation rejection %i definite", async (status) => {
    mockResponses(new Response(null, { status }));
    await expect(createVercelDeployment(TOKEN, TEAM, input)).rejects.toMatchObject({ status, uncertain: false });
  });

  it("sanitizes mutation network failures and marks them uncertain", async () => {
    const mock = vi.fn().mockRejectedValue(new Error(`Authorization: Bearer ${TOKEN}`));
    vi.stubGlobal("fetch", mock);
    const error = await createVercelDeployment(TOKEN, TEAM, input).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 504, uncertain: true });
    expect(String(error)).not.toContain(TOKEN);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not mark a failed read as an uncertain mutation", async () => {
    mockResponses(new Response(null, { status: 503 }));
    await expect(getVercelDeployment(TOKEN, TEAM, deployment.id)).rejects.toMatchObject({ status: 503, uncertain: false });
  });

  it.each(["not json", "{}"])("marks unreadable mutation success uncertain: %s", async (body) => {
    mockResponses(new Response(body));
    await expect(createVercelDeployment(TOKEN, TEAM, input)).rejects.toMatchObject({ uncertain: true });
  });

  it("marks a mutation success with interrupted body uncertain", async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error(TOKEN)); } });
    mockResponses(new Response(stream));
    const error = await createVercelDeployment(TOKEN, TEAM, input).catch((value: unknown) => value);
    expect(error).toMatchObject({ uncertain: true });
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("Vercel project env read", () => {
  it("reads decrypted env with team scope without mutating the project", async () => {
    const mock = mockResponses(Response.json({ envs: [
      { key: "DATABASE_URL", value: "db-secret", target: ["production"], decrypted: true },
      { key: "PUBLIC_URL", value: "public", target: "production" },
      { key: "SENSITIVE", value: "encrypted", decrypted: false },
      { key: "MISSING" },
    ] }));
    await expect(getVercelProjectEnv(TOKEN, TEAM, "prj_test")).resolves.toEqual([
      { key: "DATABASE_URL", value: "db-secret", target: ["production"] },
      { key: "PUBLIC_URL", value: "public", target: "production" },
      { key: "SENSITIVE" }, { key: "MISSING" },
    ]);
    const { url, init } = call(mock);
    expect(url.pathname).toBe("/v10/projects/prj_test/env");
    expect(url.searchParams.get("teamId")).toBe(TEAM);
    expect(url.searchParams.get("decrypt")).toBe("true");
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("refuses a partial env list so conflicts cannot be missed", async () => {
    mockResponses(Response.json({ envs: [], pagination: { next: 5 } }));
    await expect(getVercelProjectEnv(TOKEN, TEAM, "prj_test")).rejects.toThrow("incomplete environment");
  });
});

describe("Vercel bounded, sanitized build logs", () => {
  it("reads both documented event shapes, restores chronological order, and removes credentials and controls", async () => {
    const mock = mockResponses(Response.json([
      { text: `\u001b[31mAuthorization: Bearer other-secret\u001b[0m\u0000‮` },
      { payload: { text: `token=${TOKEN}; Bearer third-secret` } },
      { text: "first\nline\tvalue" },
    ]));
    const text = await getVercelBuildLogs(TOKEN, TEAM, deployment.id);
    expect(text).toBe("first\nline\tvalue\ntoken=[REDACTED]; Bearer [REDACTED]\nAuthorization: [REDACTED]");
    const { url } = call(mock);
    expect(url.pathname).toBe(`/v3/deployments/${deployment.id}/events`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ follow: "0", builds: "1", direction: "backward", limit: "200", teamId: TEAM });
  });

  it("bounds log output at 32000 characters after redaction", async () => {
    mockResponses(Response.json([{ text: "x".repeat(40000) + TOKEN }]));
    const text = await getVercelBuildLogs(TOKEN, TEAM, deployment.id);
    expect(text).toHaveLength(32000);
    expect(text.endsWith("[REDACTED]")).toBe(true);
    expect(text).not.toContain(TOKEN);
  });

  it("bounds response bytes before JSON parsing", async () => {
    mockResponses(Response.json([{ text: "x".repeat(1024 * 1024) }]));
    await expect(getVercelBuildLogs(TOKEN, TEAM, deployment.id)).rejects.toThrow("size limit");
  });

  it("rejects non-JSON bodies without returning any raw text", async () => {
    mockResponses(new Response(`provider failed: Bearer ${TOKEN}`));
    const error = await getVercelBuildLogs(TOKEN, TEAM, deployment.id).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VercelApiError);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("handles the documented null logs response", async () => {
    mockResponses(Response.json(null));
    await expect(getVercelBuildLogs(TOKEN, TEAM, deployment.id)).resolves.toBe("");
  });
});
