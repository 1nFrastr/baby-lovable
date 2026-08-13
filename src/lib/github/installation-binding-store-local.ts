import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDataRoot } from "@/lib/sandbox/paths";

import {
  normalizeGithubAppInstallationBinding,
  type GithubAppInstallationBinding,
} from "./installation-binding";

function bindingPath(userId: string): string {
  return path.join(
    getDataRoot(),
    "users",
    userId,
    "github-app-installation.json",
  );
}

export async function readGithubAppInstallationBindingLocal(
  userId: string,
): Promise<GithubAppInstallationBinding | null> {
  try {
    const raw = await readFile(bindingPath(userId), "utf8");
    return normalizeGithubAppInstallationBinding(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeGithubAppInstallationBindingLocal(
  binding: GithubAppInstallationBinding,
): Promise<GithubAppInstallationBinding> {
  const filePath = bindingPath(binding.userId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const payload: GithubAppInstallationBinding = {
    ...binding,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
  return payload;
}

export async function deleteGithubAppInstallationBindingLocal(
  userId: string,
): Promise<void> {
  try {
    await unlink(bindingPath(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
