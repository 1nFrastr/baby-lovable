import type { Sandbox } from "@daytona/sdk";

import {
  FREESTYLE_GIT_USERNAME,
  GIT_AUTHOR_EMAIL,
  GIT_AUTHOR_NAME,
} from "@/lib/git/freestyle-config";
import type { FreestyleGitCredentials } from "@/lib/git/freestyle-client";

import { DAYTONA_WORKSPACE_ROOT } from "./config";

export interface GitFileStatus {
  name?: string;
  staging?: string;
  worktree?: string;
}

export interface GitStatusSnapshot {
  currentBranch?: string;
  ahead?: number;
  behind?: number;
  branchPublished?: boolean;
  fileStatus?: GitFileStatus[];
}

export interface GitCommitResult {
  sha: string | null;
  committed: boolean;
  skippedReason?: string;
}

export interface DaytonaGitRunner {
  status(): Promise<GitStatusSnapshot>;
  hasChanges(): Promise<boolean>;
  /** Current HEAD commit SHA, or null when the repo has no commits yet. */
  getHeadSha(): Promise<string | null>;
  isRepoInitialized(): Promise<boolean>;
  initMain(): Promise<void>;
  configureAuthor(): Promise<void>;
  ensureRemote(remoteUrl: string): Promise<void>;
  addAll(): Promise<void>;
  commit(message: string, allowEmpty?: boolean): Promise<GitCommitResult>;
  push(credentials: FreestyleGitCredentials, branch?: string): Promise<void>;
  pull(credentials: FreestyleGitCredentials, branch?: string): Promise<void>;
  clone(
    remoteUrl: string,
    credentials: FreestyleGitCredentials,
    branch?: string,
  ): Promise<void>;
  checkoutBranch(branch: string): Promise<void>;
}

/**
 * Thin wrapper over Daytona SDK `sandbox.git.*`.
 * Never shells out to `git` via process.executeCommand.
 */
export class DaytonaSdkGitRunner implements DaytonaGitRunner {
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

/** Local / test double — records calls, never touches a real git CLI. */
export class FakeDaytonaGitRunner implements DaytonaGitRunner {
  calls: string[] = [];
  dirty = false;
  initialized = true;
  sha = "a".repeat(40);
  /** Current HEAD; updated on successful commit. Null = no commits. */
  headSha: string | null = "a".repeat(40);
  remoteUrl: string | null = null;
  failPush = false;
  failPushOnce = false;
  emptyRemote = false;

  async status(): Promise<GitStatusSnapshot> {
    this.calls.push("status");
    return {
      currentBranch: "main",
      ahead: 0,
      behind: 0,
      branchPublished: Boolean(this.remoteUrl) && !this.emptyRemote,
      fileStatus: this.dirty
        ? [{ name: "src/app/page.tsx", staging: "Modified", worktree: "Modified" }]
        : [],
    };
  }

  async hasChanges(): Promise<boolean> {
    this.calls.push("hasChanges");
    return this.dirty;
  }

  async getHeadSha(): Promise<string | null> {
    this.calls.push("getHeadSha");
    return this.headSha;
  }

  async isRepoInitialized(): Promise<boolean> {
    this.calls.push("isRepoInitialized");
    return this.initialized;
  }

  async initMain(): Promise<void> {
    this.calls.push("init");
    this.initialized = true;
  }

  async configureAuthor(): Promise<void> {
    this.calls.push("configureAuthor");
  }

  async ensureRemote(remoteUrl: string): Promise<void> {
    this.calls.push(`remoteAdd:${remoteUrl}`);
    this.remoteUrl = remoteUrl;
  }

  async addAll(): Promise<void> {
    this.calls.push("add");
  }

  async commit(
    message: string,
    _allowEmpty = false,
  ): Promise<GitCommitResult> {
    this.calls.push(`commit:${message}`);
    if (!this.dirty && !_allowEmpty) {
      return { sha: null, committed: false, skippedReason: "no changes" };
    }
    this.dirty = false;
    this.headSha = this.sha;
    return { sha: this.sha, committed: true };
  }

  async push(..._args: [FreestyleGitCredentials?, string?]): Promise<void> {
    void _args;
    this.calls.push("push");
    if (this.failPush || this.failPushOnce) {
      this.failPushOnce = false;
      throw new Error("simulated push failure");
    }
    this.emptyRemote = false;
  }

  async pull(..._args: [FreestyleGitCredentials?, string?]): Promise<void> {
    void _args;
    this.calls.push("pull");
    if (this.emptyRemote) {
      throw new Error("couldn't find remote ref main");
    }
  }

  async clone(
    remoteUrl: string,
    ..._rest: [FreestyleGitCredentials?, string?]
  ): Promise<void> {
    void _rest;
    this.calls.push(`clone:${remoteUrl}`);
    this.remoteUrl = remoteUrl;
    this.initialized = true;
  }

  async checkoutBranch(branch: string): Promise<void> {
    this.calls.push(`checkout:${branch}`);
  }
}
