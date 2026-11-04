import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: vi.fn(), token: vi.fn(), source: vi.fn(), files: vi.fn(), runtime: vi.fn(),
  createProject: vi.fn(), project: vi.fn(), env: vi.fn(), teams: vi.fn(), upload: vi.fn(),
  createDeployment: vi.fn(), deployment: vi.fn(), find: vi.fn(), logs: vi.fn(), kick: vi.fn(),
  claim: vi.fn(), patch: vi.fn(), finish: vi.fn(), bind: vi.fn(), connection: vi.fn(), target: vi.fn(),
  latest: vi.fn(), legacy: vi.fn(), select: vi.fn(), enqueue: vi.fn(), read: vi.fn(), disconnect: vi.fn(),
}));
vi.mock("@/lib/session/store", () => ({ getSessionMeta: m.session }));
vi.mock("./connect", () => ({ configuredVercelConnector: () => "vercel/publish", getAppConnectToken: m.token }));
vi.mock("./publish-source", () => ({ resolvePublishSource: m.source, exportPublishSource: m.files }));
vi.mock("./credentials", () => ({ readRuntimeIntegrations: m.runtime }));
vi.mock("./vercel-api", async (original) => ({
  ...await original<typeof import("./vercel-api")>(), createVercelProject: m.createProject,
  getVercelProject: m.project, getVercelProjectEnv: m.env, listVercelTeams: m.teams,
  uploadVercelFiles: m.upload, createVercelDeployment: m.createDeployment,
  getVercelDeployment: m.deployment, findVercelDeployment: m.find, getVercelBuildLogs: m.logs,
}));
vi.mock("./vercel-publish-store", () => ({
  claimPublishJob: m.claim, patchPublishJob: m.patch, finishPublishJob: m.finish, bindPublishProject: m.bind,
  readVercelConnection: m.connection, readPublishTarget: m.target, readLatestPublishJob: m.latest,
  readLegacyPublication: m.legacy, selectPublishTeam: m.select, enqueuePublishJob: m.enqueue,
  readPublishJob: m.read, deleteVercelConnection: m.disconnect,
}));
vi.mock("@/workflow/vercel-publish-kick", () => ({ kickVercelPublishWorkflow: m.kick }));

import { IntegrationError } from "./errors";
import { VercelApiError } from "./vercel-api";
import { choosePublishTeam, getVercelPublishProjection, reconcileVercelPublication, redactPublishLogs, startVercelPublication } from "./vercel-publish";
import type { PublishJob } from "./vercel-publish-store";

let job: PublishJob;
beforeEach(() => {
  vi.resetAllMocks();
  job = {
    id: "job-1", session_id: "sess-1", user_id: "owner", team_id: "team_user", project_id: "prj_app", project_name: "baby-app",
    repo_id: "repo-1", source_sha: "a".repeat(40), phase: "uploading", active: true, deployment_id: null, production_url: null,
    error_code: null, build_logs: null, poll_count: 0, workflow_run_id: null, lease_id: "lease", lease_until: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  m.claim.mockImplementation(async () => ({ ...job }));
  m.patch.mockImplementation(async (_job, patch) => { job = { ...job, ...patch }; return { ...job }; });
  m.finish.mockImplementation(async (_job, success, code, logs) => { job = { ...job, active: false, phase: success ? "READY" : "ERROR", error_code: code ?? null, build_logs: logs }; });
  m.session.mockResolvedValue({ id: "sess-1", userId: "owner", runStatus: "idle" });
  m.connection.mockResolvedValue({ user_id: "owner", connector: "vercel/publish" });
  m.target.mockResolvedValue({ team_id: "team_user", team_name: "User Team", project_id: "prj_app", production_url: null });
  m.token.mockResolvedValue({ token: "vercel-private" });
  m.teams.mockResolvedValue([{ id: "team_user", name: "User Team", slug: "user-team" }]);
  m.env.mockResolvedValue([]); m.runtime.mockResolvedValue(null);
  m.source.mockResolvedValue({ repoId: "repo-fixed", sha: "b".repeat(40) });
  m.files.mockResolvedValue([{ path: "package.json", content: Buffer.from("{}") }]);
  m.upload.mockResolvedValue([{ file: "package.json", sha: "file-sha", size: 2 }]);
  m.createDeployment.mockResolvedValue({ id: "dpl-1", state: "QUEUED" });
  m.project.mockResolvedValue({ id: "prj_app", name: "baby-app", productionDomain: "app.vercel.app", createdAt: Date.now() });
  m.deployment.mockResolvedValue({ id: "dpl-1", state: "BUILDING" });
  m.find.mockResolvedValue(null); m.latest.mockImplementation(async () => ({ ...job }));
  m.enqueue.mockImplementation(async () => ({ ...job })); m.legacy.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("Vercel publication reconciliation", () => {
  it("pins source before uploading and never persists tokens or environment values", async () => {
    job.phase = "pending"; job.repo_id = null; job.source_sha = null;
    await reconcileVercelPublication(job.id, "owner");
    expect(m.source).toHaveBeenCalledWith("sess-1", "owner");
    expect(job.source_sha).toBe("b".repeat(40));
    expect(job.phase).toBe("uploading"); expect(m.createDeployment).not.toHaveBeenCalled();
    expect(JSON.stringify(m.patch.mock.calls)).not.toContain("vercel-private");
  });
  it("persists mutation intent before submitting a production build", async () => {
    await reconcileVercelPublication(job.id, "owner");
    expect(m.files).toHaveBeenCalledWith("repo-1", "a".repeat(40));
    expect(m.createDeployment).toHaveBeenCalledWith("vercel-private", "team_user", expect.objectContaining({ projectId: "prj_app", jobId: "job-1", sourceSha: "a".repeat(40) }));
    const intentCall = m.patch.mock.calls.findIndex(([, patch]) => patch.phase === "submitting");
    expect(m.patch.mock.invocationCallOrder[intentCall]).toBeLessThan(m.createDeployment.mock.invocationCallOrder[0]);
    expect(job.deployment_id).toBe("dpl-1");
  });
  it("reconciles a lost create acknowledgement without creating a second deployment", async () => {
    m.createDeployment.mockRejectedValue(new VercelApiError("private", 504, true));
    await reconcileVercelPublication(job.id, "owner");
    expect(job.phase).toBe("submitting"); expect(job.active).toBe(true);
    m.find.mockResolvedValue({ id: "dpl-existing", state: "BUILDING" });
    await reconcileVercelPublication(job.id, "owner");
    expect(m.createDeployment).toHaveBeenCalledOnce();
    expect(m.find).toHaveBeenCalledWith("vercel-private", "team_user", "prj_app", "job-1");
    expect(job.deployment_id).toBe("dpl-existing");
  });
  it("reconciles a project created before a worker crashed", async () => {
    job.project_id = null; job.phase = "creating_project";
    await reconcileVercelPublication(job.id, "owner");
    expect(m.createProject).not.toHaveBeenCalled(); expect(m.bind).toHaveBeenCalledWith(expect.anything(), "prj_app", "baby-app");
    expect(job.phase).toBe("uploading");
  });
  it("does not adopt an existing project before creating the app project", async () => {
    job.project_id = null;
    await reconcileVercelPublication(job.id, "owner");
    expect(m.createProject).not.toHaveBeenCalled(); expect(job.error_code).toBe("vercel_project_conflict");
  });
  it("reports project-create permissions separately from a connected account", async () => {
    job.project_id = null; m.project.mockRejectedValue(new VercelApiError("not found", 404));
    m.createProject.mockRejectedValue(new VercelApiError("forbidden", 403));
    await reconcileVercelPublication(job.id, "owner");
    expect(job.active).toBe(false); expect(job.error_code).toBe("vercel_project_permission");
  });
  it("keeps the active slot on timeout and permits read-only outcome recovery", async () => {
    job.phase = "submitting"; job.created_at = new Date(Date.now() - 46 * 60_000).toISOString();
    expect((await reconcileVercelPublication(job.id, "owner")).done).toBe(true);
    expect(job.phase).toBe("uncertain"); expect(job.active).toBe(true); expect(m.createDeployment).not.toHaveBeenCalled();
    m.find.mockResolvedValue({ id: "dpl-late", state: "READY" });
    m.deployment.mockResolvedValue({ id: "dpl-late", state: "READY" });
    await reconcileVercelPublication(job.id, "owner");
    expect(job.phase).toBe("READY"); expect(job.production_url).toBe("https://app.vercel.app");
  });
  it("uses the stable production alias instead of the deployment URL", async () => {
    job.phase = "BUILDING"; job.deployment_id = "dpl-1";
    m.deployment.mockResolvedValue({ id: "dpl-1", state: "READY", url: "random-deployment.vercel.app" });
    await reconcileVercelPublication(job.id, "owner");
    expect(job.production_url).toBe("https://app.vercel.app"); expect(job.phase).toBe("READY");
  });
  it("does not silently change an app's existing production domain", async () => {
    job.phase = "BUILDING"; job.deployment_id = "dpl-1";
    m.target.mockResolvedValue({ production_url: "https://original.vercel.app" });
    m.deployment.mockResolvedValue({ id: "dpl-1", state: "READY" });
    await reconcileVercelPublication(job.id, "owner");
    expect(job.phase).not.toBe("READY"); expect(job.error_code).toBe("vercel_domain_changed");
  });
  it("redacts build output and records a terminal build failure", async () => {
    job.phase = "BUILDING"; job.deployment_id = "dpl-1";
    m.deployment.mockResolvedValue({ id: "dpl-1", state: "ERROR" });
    m.env.mockResolvedValue([{ key: "CUSTOM_SECRET", value: "custom-private", target: ["production"] }]);
    m.logs.mockResolvedValue("vercel-private custom-private sk_test_abc\nSyntax error: missing export");
    await reconcileVercelPublication(job.id, "owner");
    expect(job.active).toBe(false); expect(job.error_code).toBe("vercel_build_failed");
    expect(job.build_logs).toContain("Syntax error"); expect(job.build_logs).not.toMatch(/vercel-private|custom-private|sk_test_abc/);
  });
  it("never replaces a user-owned production env variable", async () => {
    m.runtime.mockResolvedValue({ stripeStatus: "linked", stripeSecrets: { secretKey: "sk_test_ourkey", publishableKey: "pk_test_ourkey" } });
    m.env.mockResolvedValue([{ key: "STRIPE_SECRET_KEY", value: "sk_test_userskey", target: ["production"] }]);
    await reconcileVercelPublication(job.id, "owner");
    expect(job.error_code).toBe("vercel_env_conflict"); expect(m.upload).not.toHaveBeenCalled(); expect(m.createDeployment).not.toHaveBeenCalled();
  });
  it("keeps tracking an already-submitted deployment after authorization expires", async () => {
    job.phase = "BUILDING"; job.deployment_id = "dpl-1";
    m.token.mockRejectedValue(new IntegrationError("private", 409, "connect_authorization_required"));
    await reconcileVercelPublication(job.id, "owner");
    expect(job.active).toBe(true); expect(job.error_code).toBe("vercel_authorization_required");
    expect(m.createDeployment).not.toHaveBeenCalled();
  });
  it("stops a replay after another worker has finished the job", async () => {
    m.claim.mockResolvedValue(null); m.read.mockResolvedValue({ ...job, active: false });
    expect((await reconcileVercelPublication(job.id, "owner")).done).toBe(true);
    expect(m.token).not.toHaveBeenCalled();
  });
});

describe("Vercel target and status boundaries", () => {
  it("requires explicit membership in the selected Team", async () => {
    await expect(choosePublishTeam("sess-1", "owner", "team_else")).rejects.toMatchObject({ code: "vercel_permission" });
    expect(m.select).not.toHaveBeenCalled();
    await choosePublishTeam("sess-1", "owner", "team_user");
    expect(m.select).toHaveBeenCalledWith("sess-1", "owner", "team_user", "User Team", "user-team");
  });
  it("does not reserve a deployment for a missing or inaccessible Team", async () => {
    m.target.mockResolvedValue(null);
    await expect(startVercelPublication("sess-1", "owner")).rejects.toMatchObject({ code: "vercel_team_required" });
    expect(m.enqueue).not.toHaveBeenCalled();
    m.target.mockResolvedValue({ team_id: "team_else" });
    await expect(startVercelPublication("sess-1", "owner")).rejects.toMatchObject({ code: "vercel_permission" });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("returns safe metadata without acquiring a provider credential", async () => {
    m.legacy.mockResolvedValue({ url: "https://previous.example", published_at: "2026-11-01" });
    const result = await getVercelPublishProjection("sess-1", "owner");
    expect(result.vercel?.teamId).toBe("team_user"); expect(result.legacyPublication?.url).toBe("https://previous.example");
    expect(m.token).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("connector");
  });
  it("redacts raw, encoded, JWT and payment credentials while keeping compiler messages", () => {
    const input = "\u001b[31mType error\u001b[0m Bearer token sk_live_abc " + encodeURIComponent("private=value") + " " + Buffer.from("private=value").toString("base64");
    expect(redactPublishLogs(input, ["private=value"])).toBe("Type error Bearer [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
  });
});
