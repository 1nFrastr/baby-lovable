import path from "node:path";

import type { ProjectSandbox } from "@/lib/sandbox/types";

import { IntegrationSecretsDecryptionError } from "./secrets";
import { readRuntimeIntegrations } from "./credentials";
import { IntegrationStorageNotReadyError } from "./store";
import { buildGeneratedAppEnv, mergeIntegrationEnvFile } from "./types";

async function readOptionalFile(
  project: ProjectSandbox,
  file: string,
): Promise<string> {
  // Listing distinguishes absence from unreadable files across both providers.
  const entries = await project.fs.listFiles(path.posix.dirname(file));
  if (!entries.some((entry) => entry.name === path.posix.basename(file))) {
    return "";
  }
  return project.fs.readTextFile(file);
}

async function protectIntegrationEnvFromGit(project: ProjectSandbox): Promise<void> {
  if (!(await project.git.isRepoInitialized())) {
    await project.git.initMain();
  }
  const gitPath = await project.process.executeCommand(
    "git rev-parse --git-path info/exclude",
    project.rootDir,
  );
  if (gitPath.exitCode !== 0 || !gitPath.stdout.trim()) {
    throw new Error("Cannot locate sandbox Git exclusions.");
  }
  const excludePath = gitPath.stdout.trim();
  await project.fs.createFolder(path.posix.dirname(excludePath));
  const current = await readOptionalFile(project, excludePath);
  // Append last so an earlier negation cannot override this exclusion.
  const exclusion = "/.env.local";
  if (current.trimEnd().split(/\r?\n/).at(-1) !== exclusion) {
    await project.fs.writeTextFile(
      excludePath,
      current + (current && !current.endsWith("\n") ? "\n" : "") + exclusion + "\n",
    );
  }
  // Ignore rules do not protect tracked/staged files. The user must explicitly
  // remove an existing tracked env file before managed credentials can be used.
  const tracked = await project.process.executeCommand(
    "git ls-files --error-unmatch -- .env.local",
    project.rootDir,
  );
  if (tracked.exitCode !== 1) {
    throw new Error("Integration environment must be untracked before adding credentials.");
  }
  const ignored = await project.process.executeCommand(
    "git check-ignore -q -- .env.local",
    project.rootDir,
  );
  if (ignored.exitCode !== 0) {
    throw new Error("Integration environment is not ignored by Git.");
  }
}

/**
 * Reconcile the managed block before preview startup. Values travel only through
 * filesystem uploads, never shell arguments, command output, or log messages.
 * Failure blocks startup; callers must not recover by launching with stale env.
 */
export async function syncIntegrationEnvToWorkspace(
  sessionId: string,
  project: ProjectSandbox,
): Promise<{ wrote: boolean; keys: string[] }> {
  try {
    const record = await readRuntimeIntegrations(sessionId).catch((error) => {
      // Existing installations without integrations must keep working before the
      // migration. A configured host, DB/network failures, and encrypted records
      // with a missing/wrong key must all fail closed.
      if (error instanceof IntegrationStorageNotReadyError &&
        !process.env.INTEGRATION_SECRETS_KEY?.trim()) {
        return null;
      }
      throw error;
    });
    const env = record ? buildGeneratedAppEnv(record) : {};
    const keys = Object.keys(env);
    const current = await readOptionalFile(project, ".env.local");
    const next = mergeIntegrationEnvFile(current, env);
    if (keys.length > 0 || next !== current) {
      await protectIntegrationEnvFromGit(project);
    }
    if (next === current) return { wrote: false, keys };
    if (next.length === 0) {
      await project.fs.deleteFile(".env.local");
    } else {
      await project.fs.writeTextFile(".env.local", next);
    }
    return { wrote: true, keys };
  } catch (error) {
    if (error instanceof IntegrationSecretsDecryptionError ||
      error instanceof IntegrationStorageNotReadyError) {
      throw error;
    }
    // SDK filesystem/command errors can include input buffers. Keep them out of
    // route errors and bootstrap logs as well as the Error.cause chain.
    throw new Error("Failed to synchronize integration environment. Preview startup was blocked.");
  }
}
