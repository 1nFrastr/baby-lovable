import type { Sandbox } from "@daytona/sdk";

import type { ProjectSandbox } from "../types";
import type { DaytonaProjectSandbox } from "../daytona-provider";
import {
  DAYTONA_VOLUME_MOUNT,
  DAYTONA_WORKSPACE_ROOT,
} from "./config";

/** Directories excluded from volume sync (ephemeral / build artifacts). */
export const DAYTONA_EPHEMERAL_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".pnpm-store",
  ".git",
  "cache",
]);

// ---------------------------------------------------------------------------
// Internal helpers — all file I/O via official @daytona/sdk fs API
// ---------------------------------------------------------------------------

interface ListedFile {
  absolutePath: string;
  relativePath: string;
}

async function listSourceFiles(
  fs: Sandbox["fs"],
  rootDir: string,
): Promise<ListedFile[]> {
  const results: ListedFile[] = [];

  async function walk(dir: string, prefix = ""): Promise<void> {
    let entries;
    try {
      entries = await fs.listFiles(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name ?? entry.path?.split("/").pop() ?? "";
      if (!name || name === "." || name === "..") continue;

      const rel = prefix ? `${prefix}/${name}` : name;
      const topSegment = rel.split("/")[0] ?? rel;
      if (DAYTONA_EPHEMERAL_DIR_NAMES.has(topSegment)) continue;

      const abs = `${rootDir}/${rel}`;
      if (entry.isDir) {
        await walk(abs, rel);
      } else {
        results.push({ absolutePath: abs, relativePath: rel });
      }
    }
  }

  await walk(rootDir);
  return results;
}

async function clearDirectoryContents(
  fs: Sandbox["fs"],
  dir: string,
): Promise<void> {
  try {
    const entries = await fs.listFiles(dir);
    for (const entry of entries) {
      const name = entry.name ?? entry.path?.split("/").pop() ?? "";
      if (!name || name === "." || name === "..") continue;
      await fs.deleteFile(`${dir}/${name}`, true);
    }
  } catch {
    // Directory may not exist yet.
  }
}

/** Clear a regular local directory (not a FUSE mount point). */
async function resetLocalDirectory(
  fs: Sandbox["fs"],
  dir: string,
): Promise<void> {
  try {
    await fs.deleteFile(dir, true);
  } catch {
    // Directory may not exist yet.
  }
  await fs.createFolder(dir, "755");
}

async function syncDirectory(
  fs: Sandbox["fs"],
  fromDir: string,
  toDir: string,
  options: { preserveMountRoot?: boolean } = {},
): Promise<number> {
  const files = await listSourceFiles(fs, fromDir);
  if (files.length === 0) return 0;

  if (options.preserveMountRoot) {
    await clearDirectoryContents(fs, toDir);
  } else {
    await resetLocalDirectory(fs, toDir);
  }

  const batch = await Promise.all(
    files.map(async (f) => {
      const content = await fs.downloadFile(f.absolutePath);
      return {
        source: content,
        destination: `${toDir}/${f.relativePath}`,
      };
    }),
  );

  await fs.uploadFiles(batch);
  return files.length;
}

function asDaytonaSandbox(
  sandbox: ProjectSandbox | DaytonaProjectSandbox,
): DaytonaProjectSandbox | null {
  return "sdkSandbox" in sandbox ? sandbox : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Whether the FUSE volume mount is reachable inside the sandbox. */
export async function isVolumeAccessible(
  sandbox: ProjectSandbox,
): Promise<boolean> {
  const daytona = asDaytonaSandbox(sandbox);
  if (!daytona) return false;
  try {
    await daytona.sdkSandbox.fs.listFiles(DAYTONA_VOLUME_MOUNT);
    return true;
  } catch {
    return false;
  }
}

/** Check whether the volume subpath has a persisted project (package.json). */
export async function volumeHasSource(
  sandbox: ProjectSandbox,
): Promise<boolean> {
  const daytona = asDaytonaSandbox(sandbox);
  if (!daytona) return false;
  if (!(await isVolumeAccessible(sandbox))) return false;
  const fs = daytona.sdkSandbox.fs;
  try {
    await fs.getFileDetails(`${DAYTONA_VOLUME_MOUNT}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore persisted source from the volume mount into the local workspace.
 * Called once at sandbox bootstrap when the local workspace is empty.
 */
export async function restoreDaytonaWorkspaceFromVolume(
  sandbox: ProjectSandbox,
): Promise<boolean> {
  const daytona = asDaytonaSandbox(sandbox);
  if (!daytona) return false;
  const sdk = daytona.sdkSandbox;

  if (!(await volumeHasSource(sandbox))) {
    return false;
  }

  await sdk.fs.createFolder(DAYTONA_WORKSPACE_ROOT, "755");

  const count = await syncDirectory(
    sdk.fs,
    DAYTONA_VOLUME_MOUNT,
    DAYTONA_WORKSPACE_ROOT,
  );

  return count > 0;
}

/**
 * Push source files from the local workspace to the volume mount.
 * Called after every agent turn completes (CLI + web).
 */
export async function persistDaytonaWorkspaceToVolume(
  sandbox: ProjectSandbox,
): Promise<boolean> {
  const daytona = asDaytonaSandbox(sandbox);
  if (!daytona) return false;
  if (!(await isVolumeAccessible(sandbox))) {
    console.warn(
      "[daytona] volume mount not accessible — skipping persist (sandbox may need recreation)",
    );
    return false;
  }
  const sdk = daytona.sdkSandbox;

  try {
    await sdk.fs.getFileDetails(`${DAYTONA_WORKSPACE_ROOT}/package.json`);
  } catch {
    return false;
  }

  const count = await syncDirectory(
    sdk.fs,
    DAYTONA_WORKSPACE_ROOT,
    DAYTONA_VOLUME_MOUNT,
    { preserveMountRoot: true },
  );

  return count > 0;
}
