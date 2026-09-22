import type { FreestyleGitCredentials } from "@/lib/git/freestyle-client";

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

/**
 * Platform Git on a sandbox working tree.
 * Daytona uses the SDK git API; Vercel shells `git` inside the adapter only.
 * Agent tools never receive this runner.
 */
export interface SandboxGitRunner {
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

/** Local / test double — records calls, never touches a real git CLI. */
export class FakeSandboxGitRunner implements SandboxGitRunner {
  calls: string[] = [];
  dirty = false;
  initialized = true;
  sha = "a".repeat(40);
  /** Current HEAD; updated on successful commit. Null = no commits. */
  headSha: string | null = "a".repeat(40);
  remoteUrl: string | null = null;
  failPush = false;
  failPushOnce = false;
  failPushError: string | null = null;
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
    if (this.failPushError) {
      throw new Error(this.failPushError);
    }
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

/** @deprecated Use FakeSandboxGitRunner */
export const FakeDaytonaGitRunner = FakeSandboxGitRunner;
