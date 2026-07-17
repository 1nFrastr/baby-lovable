import type { Sandbox } from "@daytona/sdk";

import {
  type ExecuteResult,
  type FileInfo,
  type ProjectSandbox,
  type SandboxFileSystem,
  type SandboxGitRunner,
  type SandboxProcessRunner,
} from "../types";
import { createGitRunner } from "../git-runner";
import { DAYTONA_WORKSPACE_ROOT } from "./config";

function normalizeRelativePath(targetPath: string): string {
  const normalized = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") {
    return DAYTONA_WORKSPACE_ROOT;
  }
  if (normalized.startsWith("/")) {
    return normalized;
  }
  return `${DAYTONA_WORKSPACE_ROOT}/${normalized}`;
}

function toRelativePath(absolutePath: string): string {
  const prefix = `${DAYTONA_WORKSPACE_ROOT}/`;
  if (absolutePath === DAYTONA_WORKSPACE_ROOT) {
    return ".";
  }
  if (absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length);
  }
  return absolutePath;
}

function mapFileInfo(entry: {
  name?: string;
  path?: string;
  size?: number;
  isDir?: boolean;
  modTime?: string;
}): FileInfo {
  const fullPath = entry.path ?? entry.name ?? "";
  return {
    name: entry.name ?? fullPath.split("/").pop() ?? fullPath,
    path: toRelativePath(fullPath),
    isDir: Boolean(entry.isDir),
    size: entry.size ?? 0,
    modifiedAt: entry.modTime,
  };
}

class DaytonaSandboxFileSystem implements SandboxFileSystem {
  constructor(private readonly sdkSandbox: Sandbox) {}

  async listFiles(targetPath = "."): Promise<FileInfo[]> {
    const absolute = normalizeRelativePath(targetPath);
    const entries = await this.sdkSandbox.fs.listFiles(absolute, { depth: 1 });
    return entries.map(mapFileInfo);
  }

  async readTextFile(targetPath: string): Promise<string> {
    const absolute = normalizeRelativePath(targetPath);
    const buffer = await this.sdkSandbox.fs.downloadFile(absolute);
    return buffer.toString("utf8");
  }

  async readBinaryFile(targetPath: string): Promise<Uint8Array> {
    const absolute = normalizeRelativePath(targetPath);
    const buffer = await this.sdkSandbox.fs.downloadFile(absolute);
    return new Uint8Array(buffer);
  }

  async writeTextFile(targetPath: string, content: string): Promise<void> {
    const absolute = normalizeRelativePath(targetPath);
    await this.sdkSandbox.fs.uploadFile(
      Buffer.from(content, "utf8"),
      absolute,
    );
  }

  async writeBinaryFile(targetPath: string, content: Uint8Array): Promise<void> {
    const absolute = normalizeRelativePath(targetPath);
    await this.sdkSandbox.fs.uploadFile(Buffer.from(content), absolute);
  }

  async createFolder(targetPath: string): Promise<void> {
    const absolute = normalizeRelativePath(targetPath);
    await this.sdkSandbox.fs.createFolder(absolute, "755");
  }

  async deleteFile(targetPath: string, recursive = false): Promise<void> {
    const absolute = normalizeRelativePath(targetPath);
    await this.sdkSandbox.fs.deleteFile(absolute, recursive);
  }

  async moveFiles(source: string, destination: string): Promise<void> {
    const sourcePath = normalizeRelativePath(source);
    const destinationPath = normalizeRelativePath(destination);
    await this.sdkSandbox.fs.moveFiles(sourcePath, destinationPath);
  }

  async searchFiles(targetPath: string, pattern: string): Promise<string[]> {
    const absolute = normalizeRelativePath(targetPath);
    const result = await this.sdkSandbox.fs.searchFiles(absolute, pattern);
    const files = result.files ?? [];
    return files.map((file) => toRelativePath(file));
  }

  async getFileDetails(targetPath: string): Promise<FileInfo> {
    const absolute = normalizeRelativePath(targetPath);
    const details = await this.sdkSandbox.fs.getFileDetails(absolute);
    return mapFileInfo(details);
  }
}

class DaytonaSandboxProcessRunner implements SandboxProcessRunner {
  constructor(private readonly sdkSandbox: Sandbox) {}

  async executeCommand(
    command: string,
    cwd = ".",
    env?: Record<string, string>,
    timeout = 120,
  ): Promise<ExecuteResult> {
    const workingDirectory =
      cwd === "." ? DAYTONA_WORKSPACE_ROOT : normalizeRelativePath(cwd);

    const envPrefix = env
      ? Object.entries(env)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(" ")
      : "";

    const shell = envPrefix ? `${envPrefix} ${command}` : command;

    const response = await this.sdkSandbox.process.executeCommand(
      shell,
      workingDirectory,
      undefined,
      timeout,
    );

    const stdout = response.artifacts?.stdout ?? response.result ?? "";
    const stderr = "";

    return {
      exitCode: response.exitCode,
      stdout,
      stderr,
    };
  }
}

export class DaytonaProjectSandbox implements ProjectSandbox {
  readonly id: string;
  readonly rootDir: string;
  readonly description: string;
  readonly fs: SandboxFileSystem;
  readonly process: SandboxProcessRunner;
  readonly git: SandboxGitRunner;
  readonly sdkSandbox: Sandbox;

  constructor(sessionId: string, sdkSandbox: Sandbox) {
    this.id = sessionId;
    this.sdkSandbox = sdkSandbox;
    this.rootDir = DAYTONA_WORKSPACE_ROOT;
    this.description = `Daytona sandbox ${sdkSandbox.id} for session ${sessionId}`;
    this.fs = new DaytonaSandboxFileSystem(sdkSandbox);
    this.process = new DaytonaSandboxProcessRunner(sdkSandbox);
    this.git = createGitRunner(this);
  }
}
