import type { FileInfo } from "./types";

export function normalizeWorkspacePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized.length === 0 ? "." : normalized;
}

const PROTECTED_SEGMENTS = new Set([".next", "node_modules", ".git"]);

const WRITABLE_ROOT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  ".gitignore",
]);

export type WorkspacePathOperation =
  | "read"
  | "write"
  | "edit"
  | "delete"
  | "list"
  | "search";

export function isProtectedPath(rawPath: string): boolean {
  const normalized = normalizeWorkspacePath(rawPath);
  if (normalized === ".") {
    return false;
  }

  return normalized
    .split("/")
    .some((segment) => PROTECTED_SEGMENTS.has(segment));
}

export function isAgentWritablePath(rawPath: string): boolean {
  const normalized = normalizeWorkspacePath(rawPath);
  if (!normalized || normalized === "." || isProtectedPath(normalized)) {
    return false;
  }

  if (normalized.startsWith("src/")) {
    return true;
  }

  if (normalized.startsWith("public/")) {
    return true;
  }

  return WRITABLE_ROOT_FILES.has(normalized);
}

export function isAgentDeletablePath(rawPath: string): boolean {
  const normalized = normalizeWorkspacePath(rawPath);
  if (!normalized || normalized === "." || isProtectedPath(normalized)) {
    return false;
  }

  return normalized.startsWith("src/") || normalized.startsWith("public/");
}

function operationLabel(operation: WorkspacePathOperation): string {
  switch (operation) {
    case "read":
      return "readFile";
    case "write":
      return "writeFile";
    case "edit":
      return "editFile";
    case "delete":
      return "deleteFile";
    case "list":
      return "listFiles";
    case "search":
      return "searchFiles";
  }
}

export function protectedPathError(
  operation: string,
  rawPath: string,
): string {
  return `${operation} is not allowed on managed path "${rawPath}" (.next, node_modules, .git). Use installPackage/installDependencies for dependencies and checkPreview({ restart: true }) for preview cache issues.`;
}

export function sourceOnlyPathError(
  operation: string,
  rawPath: string,
): string {
  return `${operation} is only allowed on source paths: src/**, public/**, or root config files (package.json, tsconfig.json, next.config.ts, postcss.config.mjs, eslint.config.mjs, .gitignore, pnpm-lock.yaml). Path "${rawPath}" is not writable.`;
}

export function workspacePathViolation(
  operation: WorkspacePathOperation,
  rawPath: string,
  options?: { searchPattern?: string },
): string | null {
  const normalized = normalizeWorkspacePath(rawPath);

  if (operation === "search") {
    const pattern = options?.searchPattern ?? "";
    if (
      (normalized !== "." && isProtectedPath(normalized)) ||
      /(^|\/)\.next(\/|$)|(^|\/)node_modules(\/|$)|(^|\/)\.git(\/|$)/.test(
        pattern,
      )
    ) {
      return protectedPathError(
        operationLabel(operation),
        normalized === "." ? pattern : normalized,
      );
    }
    return null;
  }

  if (operation === "list") {
    if (normalized !== "." && isProtectedPath(normalized)) {
      return protectedPathError(operationLabel(operation), normalized);
    }
    return null;
  }

  if (isProtectedPath(normalized)) {
    return protectedPathError(operationLabel(operation), normalized);
  }

  if (operation === "write" || operation === "edit") {
    if (!isAgentWritablePath(normalized)) {
      return sourceOnlyPathError(operationLabel(operation), normalized);
    }
    return null;
  }

  if (operation === "delete") {
    if (!isAgentDeletablePath(normalized)) {
      return sourceOnlyPathError(operationLabel(operation), normalized);
    }
    return null;
  }

  return null;
}

export function filterListedFiles(files: FileInfo[]): FileInfo[] {
  return files.filter((file) => !isProtectedPath(file.path));
}

/** @deprecated Use isProtectedPath */
export function isProtectedGeneratedPath(rawPath: string): boolean {
  return isProtectedPath(rawPath);
}
