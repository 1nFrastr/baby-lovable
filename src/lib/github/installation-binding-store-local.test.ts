import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteGithubAppInstallationBindingLocal,
  readGithubAppInstallationBindingLocal,
  writeGithubAppInstallationBindingLocal,
} from "./installation-binding-store-local";

describe("github app installation local store", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "gh-installation-"));
    previousDataDir = process.env.BABY_LOVABLE_DATA_DIR;
    process.env.BABY_LOVABLE_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) {
      delete process.env.BABY_LOVABLE_DATA_DIR;
    } else {
      process.env.BABY_LOVABLE_DATA_DIR = previousDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persists only non-secret installation metadata", async () => {
    const written = await writeGithubAppInstallationBindingLocal({
      userId: "user_1",
      githubLogin: "octocat",
      githubAccountId: 7,
      installationId: 42,
      updatedAt: new Date().toISOString(),
    });
    expect(written.githubLogin).toBe("octocat");

    const read = await readGithubAppInstallationBindingLocal("user_1");
    expect(read).toMatchObject({
      installationId: 42,
      githubAccountId: 7,
      githubLogin: "octocat",
    });
    expect(read).not.toHaveProperty("userAccessToken");
    expect(read).not.toHaveProperty("refreshToken");

    await deleteGithubAppInstallationBindingLocal("user_1");
    expect(
      await readGithubAppInstallationBindingLocal("user_1"),
    ).toBeNull();
  });
});
