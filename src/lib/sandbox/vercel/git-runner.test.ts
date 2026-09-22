import { describe, expect, it } from "vitest";

import { VercelShellGitRunner } from "./git-runner";
import type { ExecuteResult } from "../types";

function ok(stdout = "", stderr = ""): ExecuteResult {
  return { exitCode: 0, stdout, stderr };
}

describe("VercelShellGitRunner", () => {
  it("reports a dirty worktree from porcelain status", async () => {
    const runner = new VercelShellGitRunner(async (args) => {
      if (args.includes("rev-parse")) {
        return ok("main\n");
      }
      return ok(" M src/app/page.tsx\n");
    });
    await expect(runner.hasChanges()).resolves.toBe(true);
    const status = await runner.status();
    expect(status.currentBranch).toBe("main");
    expect(status.fileStatus?.[0]?.name).toBe("src/app/page.tsx");
  });

  it("redacts credentials from git pull errors", async () => {
    const runner = new VercelShellGitRunner(async (args) => {
      if (args.includes("get-url")) {
        return ok("https://git.freestyle.sh/demo.git\n");
      }
      throw new Error(
        "fatal: Authentication failed for 'https://x-access-token:super-secret@git.freestyle.sh/demo.git'",
      );
    });
    try {
      await runner.pull({
        username: "x-access-token",
        password: "super-secret",
      });
      throw new Error("expected pull to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/REDACTED/);
      expect(message).not.toContain("super-secret");
    }
  });

  it("skips commit when porcelain is empty", async () => {
    const runner = new VercelShellGitRunner(async (args) => {
      if (args.includes("add")) {
        return ok();
      }
      if (args.includes("commit")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "nothing to commit, working tree clean",
        };
      }
      return ok();
    });
    const result = await runner.commit("turn 1");
    expect(result.committed).toBe(false);
    expect(result.skippedReason).toMatch(/no changes/i);
  });
});
