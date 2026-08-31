import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FakeFreestyleAdapter,
  setFreestyleAdapterForTests,
} from "./freestyle-client";
import { redactSecrets } from "./provision-repo";
import { sourceControlFromRepository, emptyGitRepository } from "./types";
import { buildTurnCommitMessage } from "./commit-message";
import { FakeDaytonaGitRunner } from "@/lib/sandbox/daytona/git-runner";

describe("freestyle git helpers", () => {
  it("redacts tokens from error strings", () => {
    const raw =
      "push failed https://x-access-token:super-secret@git.freestyle.sh/r1 Bearer abc.def";
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).toContain("[REDACTED]");
  });

  it("strips jsonb-illegal NULs from persisted error text", () => {
    expect(redactSecrets("boom\u0000done")).toBe("boomdone");
  });

  it("maps repository states to sourceControl projection", () => {
    const base = emptyGitRepository("sess_1");
    expect(sourceControlFromRepository(base).status).toBe("preparing");

    expect(
      sourceControlFromRepository({
        ...base,
        provisionStatus: "ready",
        syncStatus: "syncing",
        remoteHeadSha: "abcdef0123456789",
      }).shortSha,
    ).toBe("abcdef0");

    expect(
      sourceControlFromRepository({
        ...base,
        provisionStatus: "ready",
        syncStatus: "conflict",
        syncError: "non-fast-forward",
      }).status,
    ).toBe("conflict");

    expect(
      sourceControlFromRepository({
        ...base,
        provisionStatus: "ready",
        syncStatus: "idle",
        githubSyncStatus: "linked",
        githubRepoName: "acme/app",
      }).githubRepoName,
    ).toBe("acme/app");
  });

  it("builds turn commit messages with trailers", () => {
    const message = buildTurnCommitMessage({
      turnIndex: 2,
      userPrompt: "Add a button",
      sessionId: "sess_abc",
      sessionTitle: "Todo App",
      runId: "run_1",
      outcome: "completed",
      changedFiles: ["src/app/page.tsx"],
    });
    expect(message).toContain("turn-2: Todo App");
    expect(message).toContain("Session: sess_abc");
    expect(message).toContain("Run: run_1");
    expect(message).toContain("Outcome: completed");
    expect(message).toContain("src/app/page.tsx");
  });

  it("strips jsonb-illegal characters from commit messages", () => {
    const message = buildTurnCommitMessage({
      turnIndex: 1,
      userPrompt: "hello\u0000world",
      sessionId: "sess_abc",
      runId: "run_1",
      outcome: "completed",
    });
    expect(message).toContain("helloworld");
    expect(message).not.toContain("\u0000");
  });
});

describe("FakeDaytonaGitRunner contract", () => {
  it("records SDK-style calls without shell git", async () => {
    const git = new FakeDaytonaGitRunner();
    git.dirty = true;
    await git.initMain();
    await git.ensureRemote("https://git.freestyle.sh/r1");
    await git.addAll();
    const commit = await git.commit("turn-1: test");
    await git.push({
      username: "x-access-token",
      password: "tok",
      tokenId: "t1",
    });

    expect(commit.committed).toBe(true);
    expect(git.calls).toEqual(
      expect.arrayContaining(["init", "add", "push"]),
    );
    expect(git.calls.some((c) => c.startsWith("git "))).toBe(false);
  });
});

describe("FakeFreestyleAdapter", () => {
  beforeEach(() => {
    setFreestyleAdapterForTests(null);
  });
  afterEach(() => {
    setFreestyleAdapterForTests(null);
  });

  it("creates private repo handles for tests", async () => {
    const adapter = new FakeFreestyleAdapter();
    setFreestyleAdapterForTests(adapter);
    const handle = await adapter.createPrivateRepo({ name: "sess_1" });
    expect(handle.repoId).toContain("sess_1");
    expect(handle.remoteUrl).toContain("git.freestyle.sh");
    const token = await adapter.issueWriteToken(handle.identityId);
    expect(token.username).toBe("x-access-token");
    expect(token.password).toContain("fake-token");

    const zip = await adapter.downloadRepoZip(handle.repoId, "main");
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(Buffer.from(zip).toString("latin1")).toContain("package.json");
  });
});
