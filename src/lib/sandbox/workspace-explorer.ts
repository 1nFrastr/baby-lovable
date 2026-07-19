import type { FileInfo, SandboxFileSystem } from "./types";
import {
  filterListedFiles,
  isProtectedPath,
  normalizeWorkspacePath,
  workspacePathViolation,
} from "./protected-paths";

/** Soft cap for read-only explorer content (MVP). */
export const EXPLORER_MAX_LINES = 2_000;
export const EXPLORER_MAX_BYTES = 512 * 1024;
/** Full tree walk caps — one network round-trip to the host API. */
export const EXPLORER_MAX_TREE_NODES = 2_000;
export const EXPLORER_MAX_TREE_DEPTH = 16;

/** Extra noise dirs/files beyond `.next` / `node_modules` / `.git`. */
const EXPLORER_HIDDEN_SEGMENTS = new Set([
  ".turbo",
  ".vercel",
  ".cache",
  ".pnpm-store",
  "coverage",
  "dist",
  "build",
  "out",
  ".idea",
  ".vscode",
]);

const EXPLORER_HIDDEN_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.development.local",
  ".env.production.local",
]);

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "svg",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
  "mp3",
  "mp4",
  "webm",
  "wav",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "tar",
  "7z",
  "wasm",
]);

export interface ExplorerFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt?: string;
}

/** Nested tree meta returned by a single full workspace walk. */
export interface ExplorerTreeNode extends ExplorerFileEntry {
  children?: ExplorerTreeNode[];
}

export interface ExplorerTreeResult {
  tree: ExplorerTreeNode[];
  truncated: boolean;
  nodeCount: number;
  maxNodes: number;
  maxDepth: number;
}

export interface ExplorerListResult {
  path: string;
  entries: ExplorerFileEntry[];
}

export interface ExplorerContentResult {
  path: string;
  content: string;
  binary: boolean;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
  maxLines: number;
  maxBytes: number;
  byteLength: number;
}

export function isExplorerHiddenPath(rawPath: string): boolean {
  const normalized = normalizeWorkspacePath(rawPath);
  if (normalized === ".") {
    return false;
  }

  if (isProtectedPath(normalized)) {
    return true;
  }

  const segments = normalized.split("/");
  const baseName = segments[segments.length - 1] ?? normalized;

  if (EXPLORER_HIDDEN_NAMES.has(baseName)) {
    return true;
  }

  return segments.some((segment) => EXPLORER_HIDDEN_SEGMENTS.has(segment));
}

function compareExplorerEntries(
  a: Pick<ExplorerFileEntry, "name" | "isDir">,
  b: Pick<ExplorerFileEntry, "name" | "isDir">,
): number {
  if (a.isDir !== b.isDir) {
    return a.isDir ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function filterExplorerEntries(files: FileInfo[]): ExplorerFileEntry[] {
  return filterListedFiles(files)
    .filter((file) => !isExplorerHiddenPath(file.path))
    .map((file) => ({
      name: file.name,
      path: file.path,
      isDir: file.isDir,
      size: file.size,
      modifiedAt: file.modifiedAt,
    }))
    .sort(compareExplorerEntries);
}

/**
 * Recursively walk the sandbox FS once and return nested tree meta.
 * Skips hidden/protected paths so node_modules / .next are never descended into.
 */
export async function buildExplorerTree(
  fs: Pick<SandboxFileSystem, "listFiles">,
  options?: { maxNodes?: number; maxDepth?: number; rootPath?: string },
): Promise<ExplorerTreeResult> {
  const maxNodes = options?.maxNodes ?? EXPLORER_MAX_TREE_NODES;
  const maxDepth = options?.maxDepth ?? EXPLORER_MAX_TREE_DEPTH;
  const rootPath = normalizeWorkspacePath(options?.rootPath ?? ".");

  let nodeCount = 0;
  let truncated = false;

  async function walk(
    dirPath: string,
    depth: number,
  ): Promise<ExplorerTreeNode[]> {
    if (truncated) {
      return [];
    }
    if (depth > maxDepth) {
      truncated = true;
      return [];
    }

    const listed = filterExplorerEntries(await fs.listFiles(dirPath));
    const nodes: ExplorerTreeNode[] = [];

    for (const entry of listed) {
      if (nodeCount >= maxNodes) {
        truncated = true;
        break;
      }

      nodeCount += 1;

      if (!entry.isDir) {
        nodes.push({ ...entry });
        continue;
      }

      const children =
        depth >= maxDepth
          ? ((truncated = true), [])
          : await walk(entry.path, depth + 1);

      nodes.push({
        ...entry,
        children,
      });
    }

    return nodes;
  }

  const tree = await walk(rootPath, 0);

  return {
    tree,
    truncated,
    nodeCount,
    maxNodes,
    maxDepth,
  };
}

export function assertExplorerListPath(rawPath: string): string | null {
  return workspacePathViolation("list", rawPath);
}

export function assertExplorerReadPath(rawPath: string): string | null {
  const violation = workspacePathViolation("read", rawPath);
  if (violation) {
    return violation;
  }
  if (isExplorerHiddenPath(rawPath)) {
    return `Reading "${normalizeWorkspacePath(rawPath)}" is not available in the file explorer.`;
  }
  return null;
}

function extensionOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot + 1).toLowerCase();
}

export function looksBinaryByExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(filePath));
}

export function looksBinaryContent(content: string): boolean {
  if (content.includes("\u0000")) {
    return true;
  }
  // High ratio of replacement / non-text control chars → treat as binary.
  const sample = content.slice(0, 8_192);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0 || (code < 8 && code !== 9 && code !== 10 && code !== 13)) {
      suspicious += 1;
    }
  }
  return sample.length > 0 && suspicious / sample.length > 0.02;
}

export function truncateExplorerContent(
  raw: string,
  options?: { maxLines?: number; maxBytes?: number },
): Omit<ExplorerContentResult, "path" | "binary"> {
  const maxLines = options?.maxLines ?? EXPLORER_MAX_LINES;
  const maxBytes = options?.maxBytes ?? EXPLORER_MAX_BYTES;

  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(raw);
  const totalLines = raw.length === 0 ? 0 : raw.split("\n").length;
  let truncated = false;
  let text = raw;

  if (fullBytes.byteLength > maxBytes) {
    truncated = true;
    // Decode a safe UTF-8 prefix (avoid splitting a multi-byte char).
    let end = maxBytes;
    while (end > 0 && (fullBytes[end] & 0b1100_0000) === 0b1000_0000) {
      end -= 1;
    }
    text = new TextDecoder().decode(fullBytes.subarray(0, end));
  }

  const lines = text.split("\n");
  let shown = lines;
  if (lines.length > maxLines) {
    truncated = true;
    shown = lines.slice(0, maxLines);
  } else if (truncated && totalLines > lines.length) {
    // Byte truncate already dropped trailing lines.
  }

  const content = shown.join("\n");

  return {
    content,
    truncated: truncated || shown.length < totalLines,
    totalLines,
    shownLines: shown.length,
    maxLines,
    maxBytes,
    byteLength: encoder.encode(content).byteLength,
  };
}
