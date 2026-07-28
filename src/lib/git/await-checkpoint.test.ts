import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FakeFreestyleAdapter,
  setFreestyleAdapterForTests,
} from "./freestyle-client";
import {
  ensureFreestyleRepository,
  markRepositoryReady,
} from "./provision-repo";
import { awaitPreviousCheckpoint } from "./await-checkpoint";
import {
  isActiveClaimToken,
  isClaimToken,
  newClaimToken,
} from "./workflow-run";

describe("workflow-run claim tokens", () => {
  it("creates and recognizes claim tokens", () => {
    const token = newClaimToken();
    expect(isClaimToken(token)).toBe(true);
    expect(isActiveClaimToken(token)).toBe(true);
    expect(isClaimToken("wrun_abc")).toBe(false);
    expect(isActiveClaimToken(null)).toBe(false);
  });

  it("expires old claim tokens", () => {
    const stale = `claiming:${Date.now() - 200_000}:dead`;
    expect(isClaimToken(stale)).toBe(true);
    expect(isActiveClaimToken(stale)).toBe(false);
  });
});

describe("awaitPreviousCheckpoint barrier", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "baby-git-barrier-"));
    process.env.BABY_LOVABLE_LOCAL_MODE = "1";
    process.env.BABY_LOVABLE_DATA_DIR = dataDir;
    process.env.FREESTYLE_API_KEY = "test-key";
    setFreestyleAdapterForTests(new FakeFreestyleAdapter());
  });

  afterEach(async () => {
    setFreestyleAdapterForTests(null);
    delete process.env.FREESTYLE_API_KEY;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("returns immediately when repo ready and no open tasks", async () => {
    await ensureFreestyleRepository("sess_barrier");
    await markRepositoryReady("sess_barrier", "a".repeat(40));

    await expect(
      awaitPreviousCheckpoint("sess_barrier", { timeoutMs: 2_000 }),
    ).resolves.toBeUndefined();
  });

  it("blocks on conflict", async () => {
    await ensureFreestyleRepository("sess_conflict");
    await markRepositoryReady("sess_conflict", "a".repeat(40));
    const { updateGitRepositoryWithRetry } = await import("./repository-store");
    await updateGitRepositoryWithRetry("sess_conflict", () => ({
      syncStatus: "conflict",
      syncError: "non-fast-forward",
    }));

    await expect(
      awaitPreviousCheckpoint("sess_conflict", { timeoutMs: 1_000 }),
    ).rejects.toThrow(/non-fast-forward|blocked/i);
  });
});
