export const SANDBOX_MODE = "daytona" as const;
export type SandboxMode = typeof SANDBOX_MODE;

/** Parse a sandbox mode string; returns null if invalid. */
export function parseSandboxMode(value: unknown): SandboxMode | null {
  return value === SANDBOX_MODE ? SANDBOX_MODE : null;
}

/**
 * The only supported sandbox for every environment.
 */
export function getDefaultSandboxMode(): SandboxMode {
  return SANDBOX_MODE;
}

export function assertSandboxMode(
  value: unknown,
  sessionId?: string,
): asserts value is SandboxMode {
  if (parseSandboxMode(value)) {
    return;
  }
  const suffix = sessionId ? ` for session ${sessionId}` : "";
  throw new Error(
    `Unsupported sandbox mode${suffix}: ${String(value)}. Only Daytona + Freestyle sessions are supported.`,
  );
}

export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt?: string;
}

/** One hit from workspace text search (`searchContent` → Daytona `findFiles`). */
export interface ContentSearchMatch {
  path: string;
  line: number;
  snippet: string;
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
  /** Filename glob match (Daytona `searchFiles`). */
  searchFiles(path: string, pattern: string): Promise<string[]>;
  /** Text inside files (Daytona `findFiles`; public tool is `searchContent`). */
  searchContent(path: string, query: string): Promise<ContentSearchMatch[]>;
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

export interface ProjectSandbox {
  readonly id: string;
  readonly description: string;
  readonly rootDir: string;
  fs: SandboxFileSystem;
  process: SandboxProcessRunner;
  /** Freestyle sync uses Daytona SDK git, never shell git. */
  git: import("./daytona/git-runner").DaytonaGitRunner;
}
