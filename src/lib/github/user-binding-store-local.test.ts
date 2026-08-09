import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteGithubAppUserBindingLocal,
  readGithubAppUserBindingLocal,
  writeGithubAppUserBindingLocal,
} from "./user-binding-store-local";

describe("github app user binding local store", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "gh-binding-"));
    prevDataDir = process.env.BABY_LOVABLE_DATA_DIR;
    process.env.BABY_LOVABLE_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (prevDataDir === undefined) {
      delete process.env.BABY_LOVABLE_DATA_DIR;
    } else {
      process.env.BABY_LOVABLE_DATA_DIR = prevDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes and reads binding", async () => {
    const written = await writeGithubAppUserBindingLocal({
      userId: "user_1",
      githubLogin: "acme",
      installationId: 42,
      userAccessToken: "ghu_x",
      refreshToken: "ghr_y",
      expiresAt: Date.now() + 60_000,
      updatedAt: new Date().toISOString(),
    });
    expect(written.githubLogin).toBe("acme");

    const read = await readGithubAppUserBindingLocal("user_1");
    expect(read?.userAccessToken).toBe("ghu_x");
    expect(read?.installationId).toBe(42);

    await deleteGithubAppUserBindingLocal("user_1");
    expect(await readGithubAppUserBindingLocal("user_1")).toBeNull();
  });
});
