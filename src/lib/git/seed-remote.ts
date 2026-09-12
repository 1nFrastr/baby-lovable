import { readStarterTemplateFiles } from "@/lib/sandbox/daytona/template-seed";

import { getFreestyleAdapter } from "./freestyle-client";

/**
 * Seed an empty Freestyle repo from the host via Freestyle Commits API.
 *
 * Daytona SDK `git.push` to a completely empty remote fails with
 * `malformed zero-id ref` / `illegal zero-id ref` because Freestyle's
 * no-refs advertisement omits `capabilities^{}`. Host/API seed creates
 * the first `main` commit so subsequent Daytona pull/push work.
 */
export async function seedEmptyFreestyleRepo(repoId: string): Promise<string> {
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

  return getFreestyleAdapter().createCommit({
    repoId,
    message: "init: nextjs starter",
    branch: "main",
    files,
  });
}
