import type { Sandbox } from "@daytona/sdk";

import {
  FREESTYLE_GIT_USERNAME,
  GIT_AUTHOR_EMAIL,
  GIT_AUTHOR_NAME,
} from "@/lib/git/freestyle-config";
import type { FreestyleGitCredentials } from "@/lib/git/freestyle-client";
import type {
  GitCommitResult,
  GitStatusSnapshot,
  SandboxGitRunner,
} from "../git-runner";
import { DAYTONA_WORKSPACE_ROOT } from "./config";

export type {
  GitCommitResult,
  GitFileStatus,
  GitStatusSnapshot,
  SandboxGitRunner,
} from "../git-runner";
export { FakeSandboxGitRunner, FakeDaytonaGitRunner } from "../git-runner";

/** @deprecated Use SandboxGitRunner */
export type DaytonaGitRunner = SandboxGitRunner;

/**
 * Thin wrapper over Daytona SDK `sandbox.git.*`.
 * Never shells out to `git` via process.executeCommand.
 */
export class DaytonaSdkGitRunner implements SandboxGitRunner {
  constructor(
    private readonly sdkSandbox: Sandbox,
    private readonly repoPath: string = DAYTONA_WORKSPACE_ROOT,
  ) {}

  private get git() {
    return this.sdkSandbox.git;
  }

  async status(): Promise<GitStatusSnapshot> {
    return this.git.status(this.repoPath);
  }

  async hasChanges(): Promise<boolean> {
    try {
      const status = await this.status();
      return (status.fileStatus?.length ?? 0) > 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.toLowerCase().includes("reference not found") ||
        msg.toLowerCase().includes("does not have any commits")
      ) {
        try {
          const files = await this.sdkSandbox.fs.listFiles(this.repoPath);
          return files.length > 0;
        } catch {
          return false;
        }
      }
      throw error;
    }
  }

  /**
   * Resolve HEAD via `.git` refs (Daytona SDK has no rev-parse).
   * Avoids shelling out to `git`.
   */
  async getHeadSha(): Promise<string | null> {
    try {
      const headBuf = await this.sdkSandbox.fs.downloadFile(
        `${this.repoPath}/.git/HEAD`,
      );
      const head = headBuf.toString("utf8").trim();
      if (head.startsWith("ref:")) {
        const ref = head.slice(4).trim();
        const refBuf = await this.sdkSandbox.fs.downloadFile(
          `${this.repoPath}/.git/${ref}`,
        );
        const sha = refBuf.toString("utf8").trim();
        return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
      }
      return /^[0-9a-f]{40}$/i.test(head) ? head : null;
    } catch {
      return null;
    }
  }

  async isRepoInitialized(): Promise<boolean> {
    try {
      await this.status();
      return true;
    } catch (error) {
      const msg = (
        error instanceof Error ? error.message : String(error)
      ).toLowerCase();
      if (
        msg.includes("repository does not exist") ||
        msg.includes("not a git repository")
      ) {
        return false;
      }
      return true;
    }
  }

  async initMain(): Promise<void> {
    await this.git.init(this.repoPath, false, "main");
    await this.configureAuthor();
  }

  async configureAuthor(): Promise<void> {
    await this.git.configureUser(
      GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL,
      "local",
      this.repoPath,
    );
  }

  async ensureRemote(remoteUrl: string): Promise<void> {
    const existing = await this.git.remoteGet(this.repoPath, "origin");
    if (existing === remoteUrl) {
      return;
    }
    await this.git.remoteAdd(
      this.repoPath,
      "origin",
      remoteUrl,
      false,
      Boolean(existing),
    );
  }

  async addAll(): Promise<void> {
    await this.git.add(this.repoPath, ["."]);
  }

  async commit(
    message: string,
    allowEmpty = false,
  ): Promise<GitCommitResult> {
    try {
      await this.addAll();
      const result = await this.git.commit(
        this.repoPath,
        message,
        GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL,
        allowEmpty,
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

  async push(
    credentials: FreestyleGitCredentials,
    branch = "main",
  ): Promise<void> {
    await this.git.push(
      this.repoPath,
      credentials.username || FREESTYLE_GIT_USERNAME,
      credentials.password,
      branch,
      "origin",
      true,
    );
  }

  async pull(
    credentials: FreestyleGitCredentials,
    branch = "main",
  ): Promise<void> {
    await this.git.pull(
      this.repoPath,
      credentials.username || FREESTYLE_GIT_USERNAME,
      credentials.password,
      branch,
      "origin",
    );
  }

  async clone(
    remoteUrl: string,
    credentials: FreestyleGitCredentials,
    branch = "main",
  ): Promise<void> {
    await this.git.clone(
      remoteUrl,
      this.repoPath,
      branch,
      undefined,
      credentials.username || FREESTYLE_GIT_USERNAME,
      credentials.password,
    );
  }

  async checkoutBranch(branch: string): Promise<void> {
    await this.git.checkoutBranch(this.repoPath, branch);
  }
}
