export type SandboxMode = "local" | "daytona";

export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt?: string;
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxFileSystem {
  listFiles(path: string): Promise<FileInfo[]>;
  readTextFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  writeTextFile(path: string, content: string): Promise<void>;
  writeBinaryFile(path: string, content: Uint8Array): Promise<void>;
  createFolder(path: string, mode?: string): Promise<void>;
  deleteFile(path: string, recursive?: boolean): Promise<void>;
  moveFiles(source: string, destination: string): Promise<void>;
  searchFiles(path: string, pattern: string): Promise<string[]>;
  getFileDetails(path: string): Promise<FileInfo>;
}

export interface SandboxProcessRunner {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<ExecuteResult>;
}

/** Git operations within a workspace — shell for local, Daytona SDK for remote. */
export interface SandboxGitRunner {
  ensureRepo(): Promise<{ ok: true } | { ok: false; reason: string }>;
  hasChanges(): Promise<boolean>;
  commitAll(message: string): Promise<import("./git-runner").CommitTurnResult>;
}

export interface ProjectSandbox {
  readonly id: string;
  readonly description: string;
  readonly rootDir: string;
  fs: SandboxFileSystem;
  process: SandboxProcessRunner;
  git: SandboxGitRunner;
}

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet. Daytona sandbox integration is reserved for a future release.`);
    this.name = "NotImplementedError";
  }
}
