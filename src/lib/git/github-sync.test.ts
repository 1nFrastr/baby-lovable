import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeFreestyleAdapter,
  setFreestyleAdapterForTests,
} from "./freestyle-client";
import { GithubAppError } from "@/lib/github/app-client";

import {
  createAndLinkGithubRepo,
  getGithubSyncStatus,
  GithubSyncError,
  linkGithubRepo,
  normalizeGithubRepoName,
  suggestedGithubRepoName,
  unlinkGithubRepo,
} from "./github-sync";
import { ensureFreestyleRepository } from "./provision-repo";
import {
  readGitRepository,
  updateGitRepositoryWithRetry,
} from "./repository-store";
import { emptyGitRepository, normalizeGitRepository } from "./types";

const githubClientMocks = vi.hoisted(() => ({
  createEmptyUserRepo: vi.fn(),
  resolveToken: vi.fn(),
  verifyBinding: vi.fn(),
  isConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/github/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/app-client")>();
  return {
    ...actual,
    createEmptyUserRepo: (...args: unknown[]) =>
      githubClientMocks.createEmptyUserRepo(...args),
  };
});

vi.mock("@/lib/github/user-binding-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/github/user-binding-store")>();
  return {
    ...actual,
    resolveGithubUserAccessToken: (...args: unknown[]) =>
      githubClientMocks.resolveToken(...args),
    verifyGithubAppUserBinding: (...args: unknown[]) =>
      githubClientMocks.verifyBinding(...args),
  };
});

vi.mock("@/lib/github/app-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/github/app-config")>();
  return {
    ...actual,
    isGithubAppConfigured: () => githubClientMocks.isConfigured(),
  };
});

describe("normalizeGithubRepoName", () => {
  it("accepts owner/repo and strips github URLs", () => {
    expect(normalizeGithubRepoName("acme/my-app")).toBe("acme/my-app");
    expect(
      normalizeGithubRepoName("https://github.com/acme/my-app.git"),
    ).toBe("acme/my-app");
  });

  it("rejects invalid names", () => {
    expect(() => normalizeGithubRepoName("not-a-repo")).toThrow(GithubSyncError);
    expect(() => normalizeGithubRepoName("../evil")).toThrow(GithubSyncError);
  });
});

describe("suggestedGithubRepoName", () => {
  it("derives a stable name from session id", () => {
    expect(suggestedGithubRepoName("sess_abcdefghij")).toBe(
      "baby-lovable-abcdefghij",
    );
  });
});

describe("normalizeGitRepository github fields", () => {
  it("fills defaults for legacy jsonb rows", () => {
    const legacy = emptyGitRepository("sess_1");
    const { githubRepoName, githubSyncStatus, githubSyncError, ...rest } =
      legacy;
    void githubRepoName;
    void githubSyncStatus;
    void githubSyncError;
    const normalized = normalizeGitRepository(rest as typeof legacy);
    expect(normalized.githubRepoName).toBeNull();
    expect(normalized.githubSyncStatus).toBe("idle");
    expect(normalized.githubSyncError).toBeNull();
  });
});

describe("linkGithubRepo / unlinkGithubRepo", () => {
  let dataDir: string;
  let adapter: FakeFreestyleAdapter;
  let prevDataDir: string | undefined;
  let prevLocalMode: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "github-sync-"));
    prevDataDir = process.env.BABY_LOVABLE_DATA_DIR;
    prevLocalMode = process.env.BABY_LOVABLE_LOCAL_MODE;
    process.env.BABY_LOVABLE_DATA_DIR = dataDir;
    process.env.BABY_LOVABLE_LOCAL_MODE = "1";
    process.env.FREESTYLE_API_KEY = "test-key";
    adapter = new FakeFreestyleAdapter();
    setFreestyleAdapterForTests(adapter);
  });

  afterEach(async () => {
    setFreestyleAdapterForTests(null);
    delete process.env.FREESTYLE_API_KEY;
    if (prevDataDir === undefined) {
      delete process.env.BABY_LOVABLE_DATA_DIR;
    } else {
      process.env.BABY_LOVABLE_DATA_DIR = prevDataDir;
    }
    if (prevLocalMode === undefined) {
      delete process.env.BABY_LOVABLE_LOCAL_MODE;
    } else {
      process.env.BABY_LOVABLE_LOCAL_MODE = prevLocalMode;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("enables and disables github sync via adapter", async () => {
    const sessionId = "sess_gh_1";
    const provisioned = await ensureFreestyleRepository(sessionId, "user_1");
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        provisionStatus: "ready" as const,
        provisionError: null,
      }),
      "user_1",
    );

    const linked = await linkGithubRepo(
      sessionId,
      "acme/demo-app",
      "user_1",
    );
    expect(linked.githubSyncStatus).toBe("linked");
    expect(linked.githubRepoName).toBe("acme/demo-app");
    expect(adapter.enableGithubSyncCalls).toBe(1);
    expect(adapter.githubSync.get(provisioned.repoId!)).toBe("acme/demo-app");

    const status = await getGithubSyncStatus(sessionId, "user_1");
    expect(status.linked).toBe(true);
    expect(status.githubRepoName).toBe("acme/demo-app");

    const unlinked = await unlinkGithubRepo(sessionId, "user_1");
    expect(unlinked.githubSyncStatus).toBe("idle");
    expect(unlinked.githubRepoName).toBeNull();
    expect(adapter.disableGithubSyncCalls).toBe(1);
    expect(adapter.githubSync.has(provisioned.repoId!)).toBe(false);
  });

  it("marks error when enable fails", async () => {
    const sessionId = "sess_gh_err";
    await ensureFreestyleRepository(sessionId, "user_1");
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        provisionStatus: "ready" as const,
        provisionError: null,
      }),
      "user_1",
    );
    adapter.enableGithubSyncError = "App not installed on owner/repo";

    await expect(
      linkGithubRepo(sessionId, "acme/missing", "user_1"),
    ).rejects.toThrow(GithubSyncError);

    const repo = await readGitRepository(sessionId, "user_1");
    expect(repo?.githubSyncStatus).toBe("error");
    expect(repo?.githubSyncError).toContain("App not installed");
  });

  it("rejects when freestyle repo is not ready", async () => {
    const sessionId = "sess_gh_prep";
    await ensureFreestyleRepository(sessionId, "user_1");
    await expect(
      linkGithubRepo(sessionId, "acme/demo", "user_1"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("createAndLink creates repo then enables sync", async () => {
    const sessionId = "sess_gh_create";
    await ensureFreestyleRepository(sessionId, "user_1");
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        provisionStatus: "ready" as const,
        provisionError: null,
      }),
      "user_1",
    );

    githubClientMocks.resolveToken.mockResolvedValue({
      token: "ghu_test",
      binding: {
        userId: "user_1",
        githubLogin: "acme",
        installationId: 1,
        userAccessToken: "ghu_test",
        refreshToken: null,
        expiresAt: null,
        updatedAt: new Date().toISOString(),
      },
    });
    githubClientMocks.verifyBinding.mockImplementation(
      (...args: unknown[]) => githubClientMocks.resolveToken(...args),
    );
    githubClientMocks.createEmptyUserRepo.mockResolvedValue({
      fullName: "acme/baby-lovable-ghcreate",
      name: "baby-lovable-ghcreate",
      ownerLogin: "acme",
      private: true,
      htmlUrl: "https://github.com/acme/baby-lovable-ghcreate",
    });

    const linked = await createAndLinkGithubRepo(sessionId, "user_1");
    expect(linked.githubRepoName).toBe("acme/baby-lovable-ghcreate");
    expect(linked.githubSyncStatus).toBe("linked");
    expect(githubClientMocks.createEmptyUserRepo).toHaveBeenCalled();
    expect(adapter.enableGithubSyncCalls).toBe(1);
  });

  it("createAndLink requires authorization when token missing", async () => {
    const sessionId = "sess_gh_unauth";
    await ensureFreestyleRepository(sessionId, "user_1");
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        provisionStatus: "ready" as const,
        provisionError: null,
      }),
      "user_1",
    );
    githubClientMocks.resolveToken.mockRejectedValue(
      new GithubAppError("GitHub App is not authorized for this user", 401),
    );
    githubClientMocks.verifyBinding.mockRejectedValue(
      new GithubAppError("GitHub App is not authorized for this user", 401),
    );

    await expect(
      createAndLinkGithubRepo(sessionId, "user_1"),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("FakeFreestyleAdapter githubSync", () => {
  it("stores enable/get/disable state", async () => {
    const adapter = new FakeFreestyleAdapter();
    const handle = await adapter.createPrivateRepo({ name: "r1" });
    await adapter.enableGithubSync(handle.repoId, "o/r");
    expect(await adapter.getGithubSync(handle.repoId)).toEqual({
      githubRepoName: "o/r",
    });
    await adapter.disableGithubSync(handle.repoId);
    expect(await adapter.getGithubSync(handle.repoId)).toBeNull();
  });
});
