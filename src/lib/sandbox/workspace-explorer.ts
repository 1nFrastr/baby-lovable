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
/** Soft cap for inline image previews (raster + SVG). */
export const EXPLORER_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
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
  ".env.prod",
  ".env.development",
  ".env.production",
  ".env.development.local",
  ".env.production.local",
]);

/** Previewable in the explorer via `<img>` (including SVG). */
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Non-previewable binary types — images are handled separately. */
const BINARY_EXTENSIONS = new Set([
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

export type ExplorerContentKind = "text" | "image" | "binary";
export type ExplorerContentEncoding = "utf8" | "base64";

export interface ExplorerContentResult {
  path: string;
  /** UTF-8 text, or base64 payload when `encoding` is `"base64"`. */
  content: string;
  kind: ExplorerContentKind;
  /** True only for non-previewable binaries (`kind === "binary"`). */
  binary: boolean;
  mimeType?: string;
  encoding?: ExplorerContentEncoding;
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

export function explorerImageMimeType(filePath: string): string | null {
  return IMAGE_MIME_TYPES[extensionOf(filePath)] ?? null;
}

export function looksImageByExtension(filePath: string): boolean {
  return explorerImageMimeType(filePath) !== null;
}

export function looksSvgByExtension(filePath: string): boolean {
  return extensionOf(filePath) === "svg";
}

const SVG_OPEN_TAG = /<svg\b[^>]*>/i;

function svgOpenTagAttr(openTag: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(
    openTag,
  );
  if (quoted) {
    return quoted[1];
  }
  const unquoted = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i").exec(
    openTag,
  );
  return unquoted?.[1];
}

/** CSS lengths that are not a concrete preview size (fill the parent instead). */
function parseSvgUserLength(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const value = raw.trim();
  if (value.endsWith("%") || value.startsWith("calc(")) {
    return null;
  }
  const match = /^([0-9]*\.?[0-9]+)(px)?$/i.exec(value);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseSvgViewBoxSize(
  raw: string | undefined,
): { width: number; height: number } | null {
  if (!raw) {
    return null;
  }
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    parts.length !== 4 ||
    !Number.isFinite(parts[2]) ||
    !Number.isFinite(parts[3]) ||
    parts[2] <= 0 ||
    parts[3] <= 0
  ) {
    return null;
  }
  return { width: parts[2], height: parts[3] };
}

/**
 * Intrinsic CSS pixel size for an SVG `<img>` preview.
 * Template icons often have only `viewBox` (no width/height), which Chrome
 * reports as 0×0 when the `<img>` shrink-wraps inside a flex item.
 */
export function parseSvgDisplaySize(
  svg: string,
): { width: number; height: number } | null {
  const openTag = SVG_OPEN_TAG.exec(svg)?.[0];
  if (!openTag) {
    return null;
  }

  const width = parseSvgUserLength(svgOpenTagAttr(openTag, "width"));
  const height = parseSvgUserLength(svgOpenTagAttr(openTag, "height"));
  if (width && height) {
    return { width, height };
  }

  const viewBox = parseSvgViewBoxSize(svgOpenTagAttr(openTag, "viewBox"));
  if (!viewBox) {
    return null;
  }
  if (width) {
    return { width, height: (viewBox.height / viewBox.width) * width };
  }
  if (height) {
    return { width: (viewBox.width / viewBox.height) * height, height };
  }
  return viewBox;
}

export function explorerUnsupportedBinaryResult(
  path: string,
): ExplorerContentResult {
  return {
    path,
    content: "",
    kind: "binary",
    binary: true,
    truncated: false,
    totalLines: 0,
    shownLines: 0,
    maxLines: 0,
    maxBytes: 0,
    byteLength: 0,
  };
}

export function explorerImageResult(args: {
  path: string;
  mimeType: string;
  encoding: ExplorerContentEncoding;
  content: string;
  byteLength: number;
  truncated?: boolean;
}): ExplorerContentResult {
  const truncated = Boolean(args.truncated);
  return {
    path: args.path,
    content: truncated ? "" : args.content,
    kind: "image",
    binary: false,
    mimeType: args.mimeType,
    encoding: args.encoding,
    truncated,
    totalLines: 0,
    shownLines: 0,
    maxLines: 0,
    maxBytes: EXPLORER_MAX_IMAGE_BYTES,
    byteLength: args.byteLength,
  };
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
): Omit<
  ExplorerContentResult,
  "path" | "binary" | "kind" | "mimeType" | "encoding"
> {
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
