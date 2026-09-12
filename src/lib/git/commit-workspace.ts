import type { DaytonaProjectSandbox } from "@/lib/sandbox/daytona/provider";
import type { SandboxFileSystem } from "@/lib/sandbox/types";
import {
  isProtectedPath,
  normalizeWorkspacePath,
} from "@/lib/sandbox/protected-paths";
import { isExplorerHiddenPath } from "@/lib/sandbox/workspace-explorer";

import {
  getFreestyleAdapter,
  type FreestyleCommitFile,
  type FreestyleGitCredentials,
} from "./freestyle-client";

const MAX_COMMIT_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_PATH =
  /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|otf|mp3|mp4|webm|wav|pdf|zip|gz|wasm)$/i;

function shouldSkipPath(rawPath: string): boolean {
  const path = normalizeWorkspacePath(rawPath);
  if (!path || path === ".") {
    return true;
  }
  if (isProtectedPath(path) || isExplorerHiddenPath(path)) {
    return true;
  }
  if (BINARY_PATH.test(path)) {
    return true;
  }
  return false;
}

async function collectWorkspaceCommitFiles(
  fs: Pick<SandboxFileSystem, "listFiles" | "readTextFile">,
): Promise<FreestyleCommitFile[]> {
  const files: FreestyleCommitFile[] = [];

  async function walk(dirPath: string): Promise<void> {
    if (files.length >= MAX_COMMIT_FILES) {
      return;
    }
    const listed = await fs.listFiles(dirPath);
    for (const entry of listed) {
      if (files.length >= MAX_COMMIT_FILES) {
        return;
      }
      const path = normalizeWorkspacePath(entry.path);
      if (shouldSkipPath(path)) {
        continue;
      }
      if (entry.isDir) {
        await walk(path);
        continue;
      }
      try {
        const content = await fs.readTextFile(path);
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          continue;
        }
        files.push({ path, content, encoding: "utf8" });
      } catch {
        // Skip unreadable / binary-looking files.
      }
    }
  }

  await walk(".");
  if (files.length === 0) {
    files.push({
      path: "README.md",
      content: "# baby-lovable workspace\n",
      encoding: "utf8",
    });
  }
  return files;
}

async function realignSandboxGitToFreestyle(
  project: DaytonaProjectSandbox,
  remoteUrl: string,
  credentials: FreestyleGitCredentials,
  branch: string,
): Promise<void> {
  try {
    await project.fs.deleteFile(".git", true);
  } catch {
    // Missing .git is fine — we are about to init.
  }
  await project.git.initMain();
  await project.git.ensureRemote(remoteUrl);
  await project.git.pull(credentials, branch);
  await project.git.checkoutBranch(branch);
}

/**
 * Push the current sandbox source tree through Freestyle Commits API.
 *
 * Daytona/go-git cannot create the first ref on an empty Freestyle remote
 * (`malformed zero-id ref`). After the API commit, reset local `.git` and
 * pull so later Daytona push/pull share history with Freestyle.
 */
export async function commitWorkspaceViaFreestyleApi(
  project: DaytonaProjectSandbox,
  input: {
    repoId: string;
    remoteUrl: string;
    identityId: string;
    branch: string;
    message: string;
  },
): Promise<string> {
  const files = await collectWorkspaceCommitFiles(project.fs);
  const adapter = getFreestyleAdapter();
  const sha = await adapter.createCommit({
    repoId: input.repoId,
    message: input.message,
    branch: input.branch,
    files,
  });

  const credentials = await adapter.issueWriteToken(input.identityId);
  try {
    await realignSandboxGitToFreestyle(
      project,
      input.remoteUrl,
      credentials,
      input.branch,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[git] realign after Commits API failed repo=${input.repoId}: ${detail}`,
    );
  }

  return sha;
}
