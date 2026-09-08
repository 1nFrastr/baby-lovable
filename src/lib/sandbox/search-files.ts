/**
 * Daytona `searchFiles` matches a filename glob under `path` (recursive).
 * Models often pass ripgrep-style path globs (`src` + recursive + `*.tsx`)
 * as `pattern`, which match nothing. Split those into directory + basename glob.
 */

export const SEARCH_FILES_PATH_GLOB_HINT =
  'pattern is a filename glob (e.g. *.tsx), not a path. Put the folder in path — path: "src", pattern: "*.tsx". A pattern like src/**/*.tsx matches no files.';

export function looksLikePathGlob(pattern: string): boolean {
  const trimmed = pattern.trim().replace(/\\/g, "/");
  return trimmed.includes("/") || trimmed.includes("**");
}

export function normalizeFilenameSearch(
  path: string,
  pattern: string,
): { path: string; pattern: string; rewritten: boolean } {
  const trimmed = pattern.trim().replace(/\\/g, "/");
  const basePath = path.trim() === "" ? "." : path.replace(/\\/g, "/");

  if (!looksLikePathGlob(trimmed)) {
    return { path: basePath, pattern: trimmed, rewritten: false };
  }

  const parts = trimmed.split("/").filter((part) => part && part !== ".");
  const fileGlob = parts.pop() ?? "*";
  const dirs = parts.filter((part) => part !== "**");
  const base = basePath === "." ? "" : basePath.replace(/\/+$/, "");
  const joined = [base, ...dirs].filter(Boolean).join("/");
  const nextPath = joined.length === 0 ? "." : joined;
  const nextPattern = fileGlob === "**" ? "*" : fileGlob;
  const rewritten = nextPath !== basePath || nextPattern !== trimmed;

  return { path: nextPath, pattern: nextPattern, rewritten };
}
