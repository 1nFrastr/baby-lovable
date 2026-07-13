import type { Sandbox } from "@daytona/sdk";

import type { SandboxGitRunner, SandboxProcessRunner } from "./types";

export interface CommitTurnResult {
  sha: string | null;
  committed: boolean;
  skippedReason?: string;
}

const GIT_NAME = "baby-lovable";
const GIT_EMAIL = "agent@baby-lovable.local";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Shell-based runner (local sandbox)
// ---------------------------------------------------------------------------

export class ShellGitRunner implements SandboxGitRunner {
  constructor(private readonly process: SandboxProcessRunner) {}

  async ensureRepo(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const hasGit = await this.process.executeCommand(
      "test -d .git && echo yes || echo no",
      ".",
      undefined,
      30,
    );

    if (hasGit.stdout.trim() !== "yes") {
      const init = await this.process.executeCommand(
        `git init && git config user.email ${shellQuote(GIT_EMAIL)} && git config user.name ${shellQuote(GIT_NAME)}`,
        ".",
        undefined,
        60,
      );
      if (init.exitCode !== 0) {
        return { ok: false, reason: "git init failed in workspace" };
      }
    }

    const topLevel = await this.process.executeCommand(
      "git rev-parse --show-toplevel",
      ".",
      undefined,
      30,
    );
    if (topLevel.exitCode !== 0) {
      return { ok: false, reason: "git rev-parse failed in workspace" };
    }

    return { ok: true };
  }

  async hasChanges(): Promise<boolean> {
    const status = await this.process.executeCommand(
      "git status --porcelain",
      ".",
      undefined,
      60,
    );
    if (status.exitCode !== 0) return false;
    return Boolean(status.stdout.trim());
  }

  async commitAll(message: string): Promise<CommitTurnResult> {
    const add = await this.process.executeCommand("git add -A", ".", undefined, 120);
    if (add.exitCode !== 0) {
      return { sha: null, committed: false, skippedReason: "git add failed" };
    }

    const commit = await this.process.executeCommand(
      `git commit -m ${shellQuote(message)}`,
      ".",
      undefined,
      120,
    );
    if (commit.exitCode !== 0) {
      return { sha: null, committed: false, skippedReason: "git commit failed" };
    }

    const rev = await this.process.executeCommand(
      "git rev-parse HEAD",
      ".",
      undefined,
      30,
    );
    const sha = rev.exitCode === 0 ? rev.stdout.trim() || null : null;
    return { sha, committed: true };
  }
}

// ---------------------------------------------------------------------------
// Daytona SDK native git runner
// @see https://www.daytona.io/docs — sandbox.git.*
// ---------------------------------------------------------------------------

export class DaytonaSdkGitRunner implements SandboxGitRunner {
  constructor(
    private readonly sdkSandbox: Sandbox,
    private readonly repoPath: string,
  ) {}

  async ensureRepo(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const git = this.sdkSandbox.git;
    try {
      await git.status(this.repoPath);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Fresh repo (no commits) or not yet initialised.
      if (!msg.includes("repository does not exist")) {
        return { ok: true };
      }
    }

    try {
      await git.init(this.repoPath, false, "main");
      await git.configureUser(GIT_NAME, GIT_EMAIL, "local", this.repoPath);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `git init failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async hasChanges(): Promise<boolean> {
    try {
      const status = await this.sdkSandbox.git.status(this.repoPath);
      return (status.fileStatus?.length ?? 0) > 0;
    } catch (error) {
      // Fresh repo with no commits yet — status returns "reference not found".
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("reference not found")) {
        try {
          const files = await this.sdkSandbox.fs.listFiles(this.repoPath);
          return files.length > 0;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  async commitAll(message: string): Promise<CommitTurnResult> {
    const git = this.sdkSandbox.git;
    try {
      await git.add(this.repoPath, ["."]);
      const result = await git.commit(
        this.repoPath,
        message,
        GIT_NAME,
        GIT_EMAIL,
      );
      return { sha: result.sha || null, committed: true };
    } catch (error) {
      return {
        sha: null,
        committed: false,
        skippedReason: `git commit failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export function createGitRunner(
  sandbox: { process: SandboxProcessRunner; rootDir: string } & {
    sdkSandbox?: Sandbox;
  },
): SandboxGitRunner {
  if (sandbox.sdkSandbox) {
    return new DaytonaSdkGitRunner(sandbox.sdkSandbox, sandbox.rootDir);
  }
  return new ShellGitRunner(sandbox.process);
}
