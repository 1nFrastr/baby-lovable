import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMemoryGitStores } from "./__tests__/memory-stores";
import {
  FakeFreestyleAdapter,
  setFreestyleAdapterForTests,
} from "./freestyle-client";
import { ensureFreestyleRepository } from "./provision-repo";
import { readGitRepository } from "./repository-store";
import {
  enqueueGitSyncTask,
  readGitSyncTask,
} from "./sync-task-store";
import { enqueueTurnCheckpoint, runTurnCheckpoint } from "./turn-sync";
import { FakeDaytonaGitRunner } from "@/lib/sandbox/daytona/git-runner";
import type { DaytonaProjectSandbox } from "@/lib/sandbox/daytona/provider";

describe("git repository + turn sync", () => {
  let adapter: FakeFreestyleAdapter;
  let git: FakeDaytonaGitRunner;
  let resetStores: () => void;

  beforeEach(() => {
    resetStores = installMemoryGitStores();
    process.env.FREESTYLE_API_KEY = "test-key";

    adapter = new FakeFreestyleAdapter();
    setFreestyleAdapterForTests(adapter);
    git = new FakeDaytonaGitRunner();
  });

  afterEach(() => {
    resetStores();
    setFreestyleAdapterForTests(null);
    delete process.env.FREESTYLE_API_KEY;
  });

  function fakeProject(): DaytonaProjectSandbox {
    return {
      id: "sess_test",
      description: "fake",
      rootDir: "/home/daytona/workspace",
      fs: {} as DaytonaProjectSandbox["fs"],
      process: {
        executeCommand: vi.fn(async () => {
          throw new Error("shell git must not be called");
        }),
      },
      git,
      sdkSandbox: {} as DaytonaProjectSandbox["sdkSandbox"],
    };
  }

  it("provisions a Freestyle repo binding", async () => {
    const repo = await ensureFreestyleRepository("sess_test");
    expect(repo.repoId).toBeTruthy();
    expect(repo.identityId).toBeTruthy();
    expect(adapter.createCalls).toBe(1);

    const again = await ensureFreestyleRepository("sess_test");
    expect(again.repoId).toBe(repo.repoId);
    expect(adapter.createCalls).toBe(1);
  });

  it("enqueues idempotent sync tasks per runId", async () => {
    const first = await enqueueGitSyncTask({
      sessionId: "sess_test",
      runId: "run_1",
      outcome: "completed",
      commitMessage: "turn-1: hi",
    });
    const second = await enqueueGitSyncTask({
      sessionId: "sess_test",
      runId: "run_1",
      outcome: "completed",
      commitMessage: "turn-1: hi",
    });
    expect(second.revision).toBe(first.revision);
    expect(await readGitSyncTask("sess_test", "run_1")).toEqual(first);
  });

  it("commits and pushes when workspace has changes", async () => {
    await ensureFreestyleRepository("sess_test");
    git.dirty = true;

    await enqueueTurnCheckpoint({
      sessionId: "sess_test",
      runId: "run_2",
      outcome: "completed",
      commitMessage: "turn-2: add button",
    });

    const result = await runTurnCheckpoint(
      "sess_test",
      "run_2",
      fakeProject(),
    );

    expect(result.status).toBe("synced");
    expect(result.localCommitSha).toBe(git.sha);
    expect(git.calls).toContain("push");
    expect(git.calls.some((c) => c.startsWith("commit:"))).toBe(true);

    const repo = await readGitRepository("sess_test");
    expect(repo?.syncStatus).toBe("synced");
    expect(repo?.remoteHeadSha).toBe(git.sha);
  });

  it("skips commit when there are no changes", async () => {
    await ensureFreestyleRepository("sess_test");
    git.dirty = false;
    git.headSha = null;

    await enqueueTurnCheckpoint({
      sessionId: "sess_test",
      runId: "run_3",
      outcome: "completed",
      commitMessage: "turn-3: noop",
    });

    const result = await runTurnCheckpoint(
      "sess_test",
      "run_3",
      fakeProject(),
    );
    expect(result.status).toBe("no_changes");
    expect(git.calls).not.toContain("push");
  });

  it("retries push without duplicating commit when localCommitSha exists", async () => {
    await ensureFreestyleRepository("sess_test");
    git.dirty = true;
    git.failPushOnce = true;

    await enqueueTurnCheckpoint({
      sessionId: "sess_test",
      runId: "run_4",
      outcome: "completed",
      commitMessage: "turn-4: retry",
    });

    const first = await runTurnCheckpoint(
      "sess_test",
      "run_4",
      fakeProject(),
    );
    expect(first.status).toBe("error");
    expect(first.localCommitSha).toBe(git.sha);

    const commitCalls = git.calls.filter((c) => c.startsWith("commit:")).length;
    const second = await runTurnCheckpoint(
      "sess_test",
      "run_4",
      fakeProject(),
    );
    expect(second.status).toBe("synced");
    const commitCallsAfter = git.calls.filter((c) =>
      c.startsWith("commit:"),
    ).length;
    expect(commitCallsAfter).toBe(commitCalls);
  });

  it("recovers clean-tree half-success: HEAD ahead of remote without localCommitSha", async () => {
    await ensureFreestyleRepository("sess_test");
    const remoteSha = "b".repeat(40);
    const localSha = "c".repeat(40);
    git.dirty = false;
    git.headSha = localSha;
    git.sha = localSha;

    const { updateGitRepositoryWithRetry } = await import("./repository-store");
    await updateGitRepositoryWithRetry("sess_test", () => ({
      remoteHeadSha: remoteSha,
    }));

    await enqueueTurnCheckpoint({
      sessionId: "sess_test",
      runId: "run_half",
      outcome: "completed",
      commitMessage: "turn-half: recover",
    });

    const result = await runTurnCheckpoint(
      "sess_test",
      "run_half",
      fakeProject(),
    );

    expect(result.status).toBe("synced");
    expect(result.localCommitSha).toBe(localSha);
    expect(git.calls).toContain("getHeadSha");
    expect(git.calls).toContain("push");
    expect(git.calls.some((c) => c.startsWith("commit:"))).toBe(false);

    const repo = await readGitRepository("sess_test");
    expect(repo?.remoteHeadSha).toBe(localSha);
  });

  it("marks no_changes when clean tree and HEAD matches remote", async () => {
    await ensureFreestyleRepository("sess_test");
    const sha = "d".repeat(40);
    git.dirty = false;
    git.headSha = sha;

    const { updateGitRepositoryWithRetry } = await import("./repository-store");
    await updateGitRepositoryWithRetry("sess_test", () => ({
      remoteHeadSha: sha,
    }));

    await enqueueTurnCheckpoint({
      sessionId: "sess_test",
      runId: "run_clean",
      outcome: "completed",
      commitMessage: "turn-clean",
    });

    const result = await runTurnCheckpoint(
      "sess_test",
      "run_clean",
      fakeProject(),
    );
    expect(result.status).toBe("no_changes");
    expect(git.calls).not.toContain("push");
  });

  it("never invokes process.executeCommand for git", async () => {
    await ensureFreestyleRepository("sess_test");
    git.dirty = true;
    const project = fakeProject();

    await enqueueTurnCheckpoint({
      sessionId: "sess_test",
      runId: "run_5",
      outcome: "completed",
      commitMessage: "turn-5",
    });
    await runTurnCheckpoint("sess_test", "run_5", project);

    expect(project.process.executeCommand).not.toHaveBeenCalled();
  });
});
