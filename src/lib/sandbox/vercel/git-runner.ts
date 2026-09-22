import type { FreestyleGitCredentials } from "@/lib/git/freestyle-client";
import {
  FREESTYLE_GIT_USERNAME,
  GIT_AUTHOR_EMAIL,
  GIT_AUTHOR_NAME,
} from "@/lib/git/freestyle-config";
import { redactSecrets } from "@/lib/git/provision-repo";
import type {
  GitCommitResult,
  GitStatusSnapshot,
  SandboxGitRunner,
} from "../git-runner";
import type { ExecuteResult } from "../types";
import { VERCEL_WORKSPACE_ROOT } from "./config";

type GitExec = (
  args: string[],
  options?: { env?: Record<string, string>; timeoutSec?: number },
) => Promise<ExecuteResult>;

function authedRemote(
  remoteUrl: string,
  credentials: FreestyleGitCredentials,
): string {
  const parsed = new URL(remoteUrl);
  parsed.username = credentials.username || FREESTYLE_GIT_USERNAME;
  parsed.password = credentials.password;
  return parsed.toString();
}

function wrapGitError(error: unknown): Error {
  const message = redactSecrets(
    (error instanceof Error ? error.message : String(error)).replace(
      /:\/\/[^/\s@]+@/g,
      "://[REDACTED]@",
    ),
  );
  return new Error(message);
}

/**
 * Platform Git via `git` argv inside the Vercel sandbox.
 * Credentials are passed as one-shot remote URLs and never logged.
 */
export class VercelShellGitRunner implements SandboxGitRunner {
  constructor(
    private readonly exec: GitExec,
    private readonly repoPath: string = VERCEL_WORKSPACE_ROOT,
  ) {}

  private async git(
    args: string[],
    options?: { env?: Record<string, string>; timeoutSec?: number },
  ): Promise<ExecuteResult> {
    try {
      return await this.exec(["-C", this.repoPath, ...args], options);
    } catch (error) {
      throw wrapGitError(error);
    }
  }

  async status(): Promise<GitStatusSnapshot> {
    const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const porcelain = await this.git(["status", "--porcelain"]);
    const files = porcelain.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const name = line.slice(3).trim();
        return { name, staging: line[0], worktree: line[1] };
      });
    return {
      currentBranch: branch.stdout.trim() || "main",
      ahead: 0,
      behind: 0,
      branchPublished: true,
      fileStatus: files,
    };
  }

  async hasChanges(): Promise<boolean> {
    const porcelain = await this.git(["status", "--porcelain"]);
    return porcelain.stdout.trim().length > 0;
  }

  async getHeadSha(): Promise<string | null> {
    const result = await this.git(["rev-parse", "HEAD"]);
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  }

  async isRepoInitialized(): Promise<boolean> {
    const result = await this.git(["rev-parse", "--is-inside-work-tree"]);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  async initMain(): Promise<void> {
    await this.git(["init", "-b", "main"]);
    await this.configureAuthor();
  }

  async configureAuthor(): Promise<void> {
    await this.git(["config", "user.name", GIT_AUTHOR_NAME]);
    await this.git(["config", "user.email", GIT_AUTHOR_EMAIL]);
  }

  async ensureRemote(remoteUrl: string): Promise<void> {
    const existing = await this.git(["remote", "get-url", "origin"]);
    if (existing.exitCode === 0 && existing.stdout.trim() === remoteUrl) {
      return;
    }
    if (existing.exitCode === 0) {
      await this.git(["remote", "set-url", "origin", remoteUrl]);
      return;
    }
    await this.git(["remote", "add", "origin", remoteUrl]);
  }

  async addAll(): Promise<void> {
    await this.git(["add", "-A"]);
  }

  async commit(
    message: string,
    allowEmpty = false,
  ): Promise<GitCommitResult> {
    try {
      await this.addAll();
      const args = ["commit", "-m", message];
      if (allowEmpty) {
        args.push("--allow-empty");
      }
      const result = await this.git(args);
      if (result.exitCode !== 0) {
        const detail = `${result.stdout}\n${result.stderr}`.trim();
        if (/nothing to commit/i.test(detail)) {
          return { sha: null, committed: false, skippedReason: "no changes" };
        }
        return {
          sha: null,
          committed: false,
          skippedReason: `git commit failed: ${redactSecrets(detail.slice(0, 400))}`,
        };
      }
      const sha = await this.getHeadSha();
      return { sha, committed: true };
    } catch (error) {
      return {
        sha: null,
        committed: false,
        skippedReason: `git commit failed: ${wrapGitError(error).message}`,
      };
    }
  }

  async push(
    credentials: FreestyleGitCredentials,
    branch = "main",
  ): Promise<void> {
    const url = authedRemote(
      (await this.originUrl()) ?? "origin",
      credentials,
    );
    const result = await this.git(["push", url, `HEAD:refs/heads/${branch}`], {
      timeoutSec: 120,
    });
    if (result.exitCode !== 0) {
      throw wrapGitError(
        new Error(`${result.stdout}\n${result.stderr}`.trim() || "git push failed"),
      );
    }
  }

  async pull(
    credentials: FreestyleGitCredentials,
    branch = "main",
  ): Promise<void> {
    const origin = await this.originUrl();
    if (!origin) {
      throw new Error("git pull failed: no origin remote");
    }
    const url = authedRemote(origin, credentials);
    const result = await this.git(["pull", "--ff-only", url, branch], {
      timeoutSec: 120,
    });
    if (result.exitCode !== 0) {
      throw wrapGitError(
        new Error(`${result.stdout}\n${result.stderr}`.trim() || "git pull failed"),
      );
    }
  }

  async clone(
    remoteUrl: string,
    credentials: FreestyleGitCredentials,
    branch = "main",
  ): Promise<void> {
    const url = authedRemote(remoteUrl, credentials);
    const result = await this.exec(
      ["clone", "--branch", branch, url, this.repoPath],
      { timeoutSec: 180 },
    );
    if (result.exitCode !== 0) {
      throw wrapGitError(
        new Error(`${result.stdout}\n${result.stderr}`.trim() || "git clone failed"),
      );
    }
    await this.configureAuthor();
  }

  async checkoutBranch(branch: string): Promise<void> {
    const result = await this.git(["checkout", branch]);
    if (result.exitCode !== 0) {
      throw wrapGitError(
        new Error(`${result.stdout}\n${result.stderr}`.trim() || "git checkout failed"),
      );
    }
  }

  private async originUrl(): Promise<string | null> {
    const existing = await this.git(["remote", "get-url", "origin"]);
    if (existing.exitCode !== 0) {
      return null;
    }
    return existing.stdout.trim() || null;
  }
}
