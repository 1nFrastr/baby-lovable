import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GithubAppError } from "@/lib/github/app-client";
import {
  FakeFreestyleAdapter,
  setFreestyleAdapterForTests,
} from "./freestyle-client";
import {
  getGithubSyncStatus,
  GithubSyncError,
  linkSelectedGithubRepository,
  listAvailableGithubRepositories,
  normalizeGithubRepoName,
  unlinkGithubRepo,
} from "./github-sync";
import { ensureFreestyleRepository } from "./provision-repo";
import {
  readGitRepository,
  updateGitRepositoryWithRetry,
} from "./repository-store";
import { emptyGitRepository, normalizeGitRepository } from "./types";

const githubMocks = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  getRepository: vi.fn(),
  listRepositories: vi.fn(),
  readBinding: vi.fn(),
  deleteBinding: vi.fn(),
}));

vi.mock("@/lib/github/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/app-client")>();
  return {
    ...actual,
    getGithubAppInstallation: (...args: unknown[]) =>
      githubMocks.getInstallation(...args),
    getGithubInstallationRepository: (...args: unknown[]) =>
      githubMocks.getRepository(...args),
    listGithubInstallationRepositories: (...args: unknown[]) =>
      githubMocks.listRepositories(...args),
  };
});

vi.mock("@/lib/github/installation-binding-store", () => ({
  readGithubAppInstallationBinding: (...args: unknown[]) =>
    githubMocks.readBinding(...args),
  deleteGithubAppInstallationBinding: (...args: unknown[]) =>
    githubMocks.deleteBinding(...args),
}));

vi.mock("@/lib/github/app-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/github/app-config")>();
  return { ...actual, isGithubAppConfigured: () => false };
});

describe("normalizeGithubRepoName", () => {
  it("accepts owner/repo and strips github URLs", () => {
    expect(normalizeGithubRepoName("acme/my-app")).toBe("acme/my-app");
    expect(
      normalizeGithubRepoName("https://github.com/acme/my-app.git"),
    ).toBe("acme/my-app");
  });

  it("rejects invalid names", () => {
    expect(() => normalizeGithubRepoName("not-a-repo")).toThrow(
      GithubSyncError,
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

describe("installation repository selection and Freestyle link", () => {
  let dataDir: string;
  let adapter: FakeFreestyleAdapter;
  let previousDataDir: string | undefined;
  let previousLocalMode: string | undefined;

  const identity = { id: 7, login: "octocat" };
  const binding = {
    userId: "user_1",
    installationId: 99,
    githubAccountId: 7,
    githubLogin: "octocat",
    updatedAt: new Date().toISOString(),
  };
  const installation = {
    id: 99,
    appId: 123,
    accountId: 7,
    accountLogin: "octocat",
    accountType: "User",
    repositorySelection: "selected" as const,
    suspended: false,
  };

  async function readySession(sessionId: string) {
    const provisioned = await ensureFreestyleRepository(sessionId, "user_1");
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        provisionStatus: "ready" as const,
        provisionError: null,
      }),
      "user_1",
    );
    return provisioned;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), "github-sync-"));
    previousDataDir = process.env.BABY_LOVABLE_DATA_DIR;
    previousLocalMode = process.env.BABY_LOVABLE_LOCAL_MODE;
    process.env.BABY_LOVABLE_DATA_DIR = dataDir;
    process.env.BABY_LOVABLE_LOCAL_MODE = "1";
    process.env.FREESTYLE_API_KEY = "test-key";
    adapter = new FakeFreestyleAdapter();
    setFreestyleAdapterForTests(adapter);
    githubMocks.readBinding.mockResolvedValue(binding);
    githubMocks.getInstallation.mockResolvedValue(installation);
    githubMocks.getRepository.mockResolvedValue({
      id: 321,
      fullName: "octocat/existing",
      name: "existing",
      ownerLogin: "octocat",
      private: true,
      htmlUrl: "https://github.com/octocat/existing",
      createdAt: "2026-08-13T08:00:00Z",
      size: 0,
    });
    githubMocks.listRepositories.mockResolvedValue([
      {
        id: 321,
        fullName: "octocat/existing",
        name: "existing",
        ownerLogin: "octocat",
        private: true,
        htmlUrl: "https://github.com/octocat/existing",
        createdAt: "2026-08-13T08:00:00Z",
        size: 0,
      },
    ]);
  });

  afterEach(async () => {
    setFreestyleAdapterForTests(null);
    delete process.env.FREESTYLE_API_KEY;
    if (previousDataDir === undefined) {
      delete process.env.BABY_LOVABLE_DATA_DIR;
    } else {
      process.env.BABY_LOVABLE_DATA_DIR = previousDataDir;
    }
    if (previousLocalMode === undefined) {
      delete process.env.BABY_LOVABLE_LOCAL_MODE;
    } else {
      process.env.BABY_LOVABLE_LOCAL_MODE = previousLocalMode;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("lists only empty repositories from the verified installation", async () => {
    githubMocks.listRepositories.mockResolvedValue([
      {
        id: 321,
        fullName: "octocat/empty",
        size: 0,
      },
      {
        id: 322,
        fullName: "octocat/initialized",
        size: 4,
      },
    ]);
    const repositories = await listAvailableGithubRepositories(
      "user_1",
      identity,
    );
    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.fullName).toBe("octocat/empty");
    expect(githubMocks.listRepositories).toHaveBeenCalledWith(99);
  });

  it("links only the repository selected by id, then unlinks", async () => {
    const sessionId = "sess_gh_1";
    const provisioned = await readySession(sessionId);
    const linked = await linkSelectedGithubRepository(
      sessionId,
      321,
      "user_1",
      identity,
    );
    expect(githubMocks.getRepository).toHaveBeenCalledWith(99, 321, {
      requireEmpty: true,
    });
    expect(linked.githubRepoName).toBe("octocat/existing");
    expect(adapter.githubSync.get(provisioned.repoId!)).toBe(
      "octocat/existing",
    );

    const status = await getGithubSyncStatus(sessionId, "user_1", {
      githubIdentity: identity,
    });
    expect(status.linked).toBe(true);
    expect(status.installed).toBe(true);

    const unlinked = await unlinkGithubRepo(sessionId, "user_1");
    expect(unlinked.githubSyncStatus).toBe("idle");
    expect(adapter.githubSync.has(provisioned.repoId!)).toBe(false);
  });

  it("rejects a repository outside the installation scope", async () => {
    const sessionId = "sess_gh_scope";
    await readySession(sessionId);
    githubMocks.getRepository.mockRejectedValue(
      new GithubAppError("Repository access denied", 422),
    );
    await expect(
      linkSelectedGithubRepository(sessionId, 999, "user_1", identity),
    ).rejects.toMatchObject({ status: 403 });
    expect(adapter.enableGithubSyncCalls).toBe(0);
  });

  it("rejects a repository that gained a commit before linking", async () => {
    const sessionId = "sess_gh_nonempty";
    await readySession(sessionId);
    githubMocks.getRepository.mockRejectedValue(
      new GithubAppError("只能连接没有任何 commit 的空仓库", 409),
    );
    await expect(
      linkSelectedGithubRepository(sessionId, 321, "user_1", identity),
    ).rejects.toMatchObject({ status: 409 });
    expect(adapter.enableGithubSyncCalls).toBe(0);
  });

  it("rejects an installation bound to another GitHub identity", async () => {
    const sessionId = "sess_gh_identity";
    await readySession(sessionId);
    await expect(
      linkSelectedGithubRepository(
        sessionId,
        321,
        "user_1",
        { id: 8, login: "other" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(githubMocks.getRepository).not.toHaveBeenCalled();
  });

  it("records Freestyle enable errors", async () => {
    const sessionId = "sess_gh_error";
    await readySession(sessionId);
    adapter.enableGithubSyncError = "Failed to access GitHub repository";
    await expect(
      linkSelectedGithubRepository(sessionId, 321, "user_1", identity),
    ).rejects.toMatchObject({ status: 502 });
    const repo = await readGitRepository(sessionId, "user_1");
    expect(repo?.githubSyncStatus).toBe("error");
  });

  it("rejects linking before the Freestyle repository is ready", async () => {
    const sessionId = "sess_gh_pending";
    await ensureFreestyleRepository(sessionId, "user_1");
    await expect(
      linkSelectedGithubRepository(sessionId, 321, "user_1", identity),
    ).rejects.toMatchObject({ status: 409 });
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
