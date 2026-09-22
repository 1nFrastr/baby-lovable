import type { Sandbox } from "@vercel/sandbox";

import type {
  ContentSearchMatch,
  ExecuteResult,
  FileInfo,
  ProjectSandbox,
  SandboxFileSystem,
  SandboxProcessRunner,
} from "../types";
import { VercelShellGitRunner } from "./git-runner";
import { VERCEL_WORKSPACE_ROOT } from "./config";
import { ensureVercelWorkspaceRoot } from "./workspace-root";

function normalizeRelativePath(targetPath: string): string {
  const normalized = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") {
    return VERCEL_WORKSPACE_ROOT;
  }
  if (normalized.startsWith("/")) {
    return normalized;
  }
  return `${VERCEL_WORKSPACE_ROOT}/${normalized}`;
}

function toRelativePath(absolutePath: string): string {
  const prefix = `${VERCEL_WORKSPACE_ROOT}/`;
  if (absolutePath === VERCEL_WORKSPACE_ROOT) {
    return ".";
  }
  if (absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length);
  }
  return absolutePath;
}

async function commandResult(
  command: Awaited<ReturnType<Sandbox["runCommand"]>>,
): Promise<ExecuteResult> {
  const stdout =
    "stdout" in command && typeof command.stdout === "function"
      ? await command.stdout()
      : "";
  const stderr =
    "stderr" in command && typeof command.stderr === "function"
      ? await command.stderr()
      : "";
  return {
    exitCode: command.exitCode ?? 0,
    stdout,
    stderr,
  };
}

class VercelSandboxFileSystem implements SandboxFileSystem {
  constructor(
    private readonly sdk: Sandbox,
    private readonly process: SandboxProcessRunner,
  ) {}

  async listFiles(targetPath = "."): Promise<FileInfo[]> {
    const absolute = normalizeRelativePath(targetPath);
    const entries = await this.sdk.fs.readdir(absolute, {
      withFileTypes: true,
    });
    const mapped: FileInfo[] = [];
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.name;
      const full = `${absolute}/${name}`;
      let isDir = typeof entry !== "string" && "isDirectory" in entry
        ? entry.isDirectory()
        : false;
      let size = 0;
      if (typeof entry === "string" || !("isDirectory" in entry)) {
        try {
          const stat = await this.sdk.fs.stat(full);
          isDir = stat.isDirectory();
          size = stat.size;
        } catch {
          // skip
        }
      }
      mapped.push({
        name,
        path: toRelativePath(full),
        isDir,
        size,
      });
    }
    return mapped;
  }

  async readTextFile(targetPath: string): Promise<string> {
    const buffer = await this.readBinaryFile(targetPath);
    return new TextDecoder().decode(buffer);
  }

  async readBinaryFile(targetPath: string): Promise<Uint8Array> {
    const absolute = normalizeRelativePath(targetPath);
    const buffer = await this.sdk.readFileToBuffer({ path: absolute });
    if (!buffer) {
      throw new Error(`File not found: ${targetPath}`);
    }
    return new Uint8Array(buffer);
  }

  async writeTextFile(targetPath: string, content: string): Promise<void> {
    await this.writeBinaryFile(targetPath, new TextEncoder().encode(content));
  }

  async writeBinaryFile(targetPath: string, content: Uint8Array): Promise<void> {
    const absolute = normalizeRelativePath(targetPath);
    await this.sdk.writeFiles([
      { path: absolute, content: Buffer.from(content) },
    ]);
  }

  async createFolder(targetPath: string): Promise<void> {
    const absolute = normalizeRelativePath(targetPath);
    await this.sdk.fs.mkdir(absolute, { recursive: true });
  }

  async deleteFile(targetPath: string, recursive = false): Promise<void> {
    const absolute = normalizeRelativePath(targetPath);
    await this.sdk.fs.rm(absolute, { recursive, force: true });
  }

  async moveFiles(source: string, destination: string): Promise<void> {
    await this.sdk.fs.rename(
      normalizeRelativePath(source),
      normalizeRelativePath(destination),
    );
  }

  async searchFiles(targetPath: string, pattern: string): Promise<string[]> {
    const absolute = normalizeRelativePath(targetPath);
    const result = await this.process.executeCommand(
      `find ${JSON.stringify(absolute)} -type f -name ${JSON.stringify(pattern)}`,
      ".",
      undefined,
      30,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((file) => toRelativePath(file));
  }

  async searchContent(
    targetPath: string,
    query: string,
  ): Promise<ContentSearchMatch[]> {
    const absolute = normalizeRelativePath(targetPath);
    const quoted = JSON.stringify(query);
    const result = await this.process.executeCommand(
      `rg -n --no-heading --hidden -g '!.git' -g '!node_modules' -g '!.next' ${quoted} ${JSON.stringify(absolute)} 2>/dev/null || grep -RIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next ${quoted} ${JSON.stringify(absolute)} || true`,
      ".",
      undefined,
      30,
    );
    const matches: ContentSearchMatch[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) {
        continue;
      }
      matches.push({
        path: toRelativePath(match[1] ?? ""),
        line: Number(match[2]),
        snippet: match[3] ?? "",
      });
    }
    return matches;
  }

  async getFileDetails(targetPath: string): Promise<FileInfo> {
    const absolute = normalizeRelativePath(targetPath);
    const stat = await this.sdk.fs.stat(absolute);
    return {
      name: absolute.split("/").pop() ?? targetPath,
      path: toRelativePath(absolute),
      isDir: stat.isDirectory(),
      size: stat.size,
    };
  }
}

class VercelSandboxProcessRunner implements SandboxProcessRunner {
  constructor(private readonly sdk: Sandbox) {}

  async executeCommand(
    command: string,
    cwd = ".",
    env?: Record<string, string>,
    timeout = 120,
  ): Promise<ExecuteResult> {
    await ensureVercelWorkspaceRoot(this.sdk);
    const workingDirectory =
      cwd === "." ? VERCEL_WORKSPACE_ROOT : normalizeRelativePath(cwd);
    const envPrefix = env
      ? Object.entries(env)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(" ")
      : "";
    const shell = envPrefix ? `${envPrefix} ${command}` : command;
    const response = await this.sdk.runCommand({
      cmd: "bash",
      args: ["-lc", shell],
      cwd: workingDirectory,
      timeoutMs: timeout * 1000,
    });
    return commandResult(response);
  }

  async runGit(
    args: string[],
    options?: { env?: Record<string, string>; timeoutSec?: number },
  ): Promise<ExecuteResult> {
    await ensureVercelWorkspaceRoot(this.sdk);
    const isClone = args[0] === "clone";
    const response = await this.sdk.runCommand({
      cmd: "git",
      args,
      cwd: isClone ? "/" : VERCEL_WORKSPACE_ROOT,
      env: options?.env,
      timeoutMs: (options?.timeoutSec ?? 120) * 1000,
    });
    return commandResult(response);
  }
}

export class VercelProjectSandbox implements ProjectSandbox {
  readonly id: string;
  readonly sandboxId: string;
  readonly rootDir: string;
  readonly description: string;
  readonly fs: SandboxFileSystem;
  readonly process: SandboxProcessRunner;
  readonly git: VercelShellGitRunner;
  readonly sdkSandbox: Sandbox;

  constructor(sessionId: string, sdkSandbox: Sandbox) {
    this.id = sessionId;
    this.sdkSandbox = sdkSandbox;
    this.sandboxId = sdkSandbox.name;
    this.rootDir = VERCEL_WORKSPACE_ROOT;
    this.description = `Vercel sandbox ${sdkSandbox.name} for session ${sessionId}`;
    const processRunner = new VercelSandboxProcessRunner(sdkSandbox);
    this.process = processRunner;
    this.fs = new VercelSandboxFileSystem(sdkSandbox, processRunner);
    this.git = new VercelShellGitRunner(
      (args, options) => processRunner.runGit(args, options),
      VERCEL_WORKSPACE_ROOT,
    );
  }
}

export function asVercelProject(project: ProjectSandbox): VercelProjectSandbox {
  if (project instanceof VercelProjectSandbox) {
    return project;
  }
  if ("sdkSandbox" in project) {
    return project as VercelProjectSandbox;
  }
  throw new Error("Expected a Vercel project sandbox");
}
