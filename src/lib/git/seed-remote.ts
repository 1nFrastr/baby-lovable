import { Freestyle } from "freestyle";

import { readStarterTemplateFiles } from "@/lib/sandbox/daytona/template-seed";

import {
  getFreestyleApiKey,
  GIT_AUTHOR_EMAIL,
  GIT_AUTHOR_NAME,
} from "./freestyle-config";

function extractCommitSha(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.sha === "string") {
    return obj.sha;
  }
  const commit = obj.commit;
  if (commit && typeof commit === "object") {
    const sha = (commit as { sha?: unknown }).sha;
    if (typeof sha === "string") {
      return sha;
    }
  }
  return null;
}

/**
 * Seed an empty Freestyle repo from the host via Freestyle Commits API.
 *
 * Daytona SDK `git.push` to a completely empty remote fails with
 * `illegal zero-id ref`. Host/API seed creates the first `main` commit so
 * subsequent Daytona pull/push work.
 */
export async function seedEmptyFreestyleRepo(repoId: string): Promise<string> {
  const client = new Freestyle({ apiKey: getFreestyleApiKey() });
  const repo = client.git.repos.ref({ repoId });

  const starter = await readStarterTemplateFiles();
  const files = starter
    .filter((file) => {
      const p = file.relativePath.replace(/\\/g, "/");
      if (p.startsWith("node_modules/") || p.includes("/node_modules/")) {
        return false;
      }
      if (p.startsWith(".next/") || p.includes("/.next/")) {
        return false;
      }
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot)$/i.test(p)) {
        return false;
      }
      return true;
    })
    .slice(0, 200)
    .map((file) => ({
      path: file.relativePath,
      content: file.content.toString("utf8"),
      encoding: "utf8" as const,
    }));

  if (files.length === 0) {
    files.push({
      path: "README.md",
      content: "# baby-lovable workspace\n",
      encoding: "utf8",
    });
  }

  const result = await repo.commits.create({
    message: "init: nextjs starter",
    branch: "main",
    files,
    author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
  });

  const sha = extractCommitSha(result);
  if (sha) {
    return sha;
  }

  const listed = (await repo.commits.list({
    branch: "main",
    limit: 1,
    order: "desc",
  })) as { commits?: Array<{ sha?: string }> };
  const tip = listed.commits?.[0]?.sha;
  if (!tip) {
    throw new Error("Freestyle seed commit did not return a SHA");
  }
  return tip;
}
