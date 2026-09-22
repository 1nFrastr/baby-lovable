import type { SandboxGitRunner } from "./git-runner";

export const SANDBOX_MODES = ["daytona", "vercel"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

const SANDBOX_MODE_SET = new Set<string>(SANDBOX_MODES);

/** Parse a sandbox mode string; returns null if invalid. */
export function parseSandboxMode(value: unknown): SandboxMode | null {
  if (typeof value !== "string") {
    return null;
  }
  return SANDBOX_MODE_SET.has(value) ? (value as SandboxMode) : null;
}

function readProviderEnv(): SandboxMode | null {
  const raw = process.env.SANDBOX_PROVIDER?.trim().toLowerCase();
  return parseSandboxMode(raw);
}

/**
 * New sessions pick a provider from SANDBOX_PROVIDER (daytona | vercel).
 * Default is Vercel Sandbox. Existing sessions stay sticky on sandbox_mode.
 */
export function getDefaultSandboxMode(): SandboxMode {
  return readProviderEnv() ?? "vercel";
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
    `Unsupported sandbox mode${suffix}: ${String(value)}. Supported: ${SANDBOX_MODES.join(", ")}.`,
  );
}

export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt?: string;
}

/** One hit from workspace text search. */
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
  /** Filename glob match. */
  searchFiles(path: string, pattern: string): Promise<string[]>;
  /** Text inside files. */
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
  /** Provider VM / named-sandbox id (opaque to callers). */
  readonly sandboxId: string;
  readonly description: string;
  readonly rootDir: string;
  fs: SandboxFileSystem;
  process: SandboxProcessRunner;
  git: SandboxGitRunner;
}

export type { SandboxGitRunner } from "./git-runner";
