/**
 * Local ProjectSandbox adapter (fs / process / git on disk).
 * Lifecycle (ensure / status) lives in ./sandbox.ts.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  type ExecuteResult,
  type FileInfo,
  type ProjectSandbox,
  type SandboxFileSystem,
  type SandboxProcessRunner,
} from "../types";
import { getWorkspaceRoot, resolveWorkspacePath } from "../paths";

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOBSTAR___/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`);
}

function toRelativePath(sessionId: string, absolutePath: string): string {
  const workspaceRoot = getWorkspaceRoot(sessionId);
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

async function walkDirectory(
  sessionId: string,
  directory: string,
  visitor: (absolutePath: string, stats: Awaited<ReturnType<typeof fs.stat>>) => Promise<void>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const stats = await fs.stat(absolutePath);
    await visitor(absolutePath, stats);

    if (entry.isDirectory()) {
      await walkDirectory(sessionId, absolutePath, visitor);
    }
  }
}

class LocalSandboxFileSystem implements SandboxFileSystem {
  constructor(private readonly sessionId: string) {}

  async listFiles(targetPath = "."): Promise<FileInfo[]> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    return Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(absolutePath, entry.name);
        const stats = await fs.stat(entryPath);

        return {
          name: entry.name,
          path: toRelativePath(this.sessionId, entryPath),
          isDir: entry.isDirectory(),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      }),
    );
  }

  async readTextFile(targetPath: string): Promise<string> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    return fs.readFile(absolutePath, "utf8");
  }

  async readBinaryFile(targetPath: string): Promise<Uint8Array> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    const buffer = await fs.readFile(absolutePath);
    return new Uint8Array(buffer);
  }

  async writeTextFile(targetPath: string, content: string): Promise<void> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }

  async writeBinaryFile(targetPath: string, content: Uint8Array): Promise<void> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }

  async createFolder(targetPath: string): Promise<void> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    await fs.mkdir(absolutePath, { recursive: true });
  }

  async deleteFile(targetPath: string, recursive = false): Promise<void> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    await fs.rm(absolutePath, { recursive, force: true });
  }

  async moveFiles(source: string, destination: string): Promise<void> {
    const sourcePath = resolveWorkspacePath(this.sessionId, source);
    const destinationPath = resolveWorkspacePath(this.sessionId, destination);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.rename(sourcePath, destinationPath);
  }

  async searchFiles(targetPath: string, pattern: string): Promise<string[]> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    const matcher = globToRegExp(pattern);
    const matches: string[] = [];

    await walkDirectory(this.sessionId, absolutePath, async (filePath, stats) => {
      if (!stats.isFile()) {
        return;
      }

      const relativePath = toRelativePath(this.sessionId, filePath);
      if (matcher.test(relativePath) || matcher.test(path.basename(relativePath))) {
        matches.push(relativePath);
      }
    });

    return matches.sort();
  }

  async getFileDetails(targetPath: string): Promise<FileInfo> {
    const absolutePath = resolveWorkspacePath(this.sessionId, targetPath);
    const stats = await fs.stat(absolutePath);

    return {
      name: path.basename(absolutePath),
      path: toRelativePath(this.sessionId, absolutePath),
      isDir: stats.isDirectory(),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  }
}

class LocalSandboxProcessRunner implements SandboxProcessRunner {
  constructor(
    private readonly sessionId: string,
    private readonly rootDir: string,
  ) {}

  async executeCommand(
    command: string,
    cwd = ".",
    env?: Record<string, string>,
    timeout = 120,
  ): Promise<ExecuteResult> {
    const workingDirectory = resolveWorkspacePath(this.sessionId, cwd);

    return new Promise<ExecuteResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd: workingDirectory,
        env: { ...process.env, ...env },
        shell: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);

        if (timedOut) {
          reject(new Error(`Command timed out after ${timeout}s: ${command}`));
          return;
        }

        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }
}

export class LocalProjectSandbox implements ProjectSandbox {
  readonly id: string;
  readonly rootDir: string;
  readonly description: string;
  readonly fs: SandboxFileSystem;
  readonly process: SandboxProcessRunner;

  constructor(sessionId: string) {
    this.id = sessionId;
    this.rootDir = getWorkspaceRoot(sessionId);
    this.description = `Local workspace at ${this.rootDir}`;
    this.fs = new LocalSandboxFileSystem(sessionId);
    this.process = new LocalSandboxProcessRunner(sessionId, this.rootDir);
  }
}
