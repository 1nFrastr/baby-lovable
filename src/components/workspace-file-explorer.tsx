"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ExplorerContentResult,
  ExplorerTreeNode,
  ExplorerTreeResult,
} from "@/lib/sandbox/workspace-explorer";

import { CodeHighlight } from "./code-highlight";

interface WorkspaceFileExplorerProps {
  sessionId: string;
  /** Bump after each agent turn (or manual refresh) to re-sync from sandbox. */
  refreshKey: number;
  /** Lets the panel toolbar show the single refresh spinner. */
  onBusyChange?: (busy: boolean) => void;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new Error(
      (data && "error" in data && data.error) ||
        `Request failed (${response.status})`,
    );
  }
  return data as T;
}

function collectDirPaths(nodes: ExplorerTreeNode[], into: Set<string>): void {
  for (const node of nodes) {
    if (!node.isDir) {
      continue;
    }
    into.add(node.path);
    if (node.children?.length) {
      collectDirPaths(node.children, into);
    }
  }
}

function explorerImageDataUrl(result: ExplorerContentResult): string | null {
  if (result.kind !== "image" || !result.mimeType || !result.content) {
    return null;
  }
  if (result.encoding === "base64") {
    return `data:${result.mimeType};base64,${result.content}`;
  }
  return `data:${result.mimeType};charset=utf-8,${encodeURIComponent(result.content)}`;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${bytes} B`;
}

function ExplorerImagePreview({
  result,
}: {
  result: ExplorerContentResult;
}) {
  const src = explorerImageDataUrl(result);
  if (result.truncated && !src) {
    return (
      <p className="px-4 py-3 text-sm text-zinc-500">
        {result.byteLength > 0
          ? `Image is too large to preview (${formatByteSize(result.byteLength)}; max ${formatByteSize(result.maxBytes)}).`
          : `Image is too large to preview (max ${formatByteSize(result.maxBytes)}).`}
      </p>
    );
  }
  if (!src) {
    return (
      <p className="px-4 py-3 text-sm text-zinc-500">
        Image preview is not available.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-6">
      <div className="max-h-full max-w-full overflow-hidden rounded-md border border-zinc-200 bg-[image:repeating-conic-gradient(#e4e4e7_0_25%,#fafafa_0_50%)] bg-[size:16px_16px] dark:border-zinc-800 dark:bg-[image:repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)]">
        {/* SVG is rendered via <img> so scripts in the markup do not run. */}
        <img
          src={src}
          alt={result.path}
          className="max-h-[min(70vh,640px)] max-w-full object-contain"
        />
      </div>
    </div>
  );
}

function FileTreeNode({
  node,
  depth,
  expanded,
  selectedPath,
  onToggleDir,
  onSelectFile,
}: {
  node: ExplorerTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const selected = selectedPath === node.path;
  const children = node.children ?? [];

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if (node.isDir) {
            onToggleDir(node.path);
          } else {
            onSelectFile(node.path);
          }
        }}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[12px] leading-5 transition ${
          selected
            ? "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100"
            : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        }`}
        style={{ paddingLeft: 6 + depth * 12 }}
        title={node.path}
      >
        <span
          className="flex h-3 w-3 shrink-0 items-center justify-center text-zinc-400"
          aria-hidden
        >
          {node.isDir ? (
            isOpen ? (
              <ChevronDown className="h-3 w-3" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
            )
          ) : null}
        </span>
        <span className="min-w-0 truncate">{node.name}</span>
      </button>

      {node.isDir && isOpen ? (
        <ul className="m-0 list-none p-0">
          {children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
          {children.length === 0 ? (
            <li
              className="px-2 py-0.5 text-[11px] text-zinc-400"
              style={{ paddingLeft: 18 + depth * 12 }}
            >
              (empty)
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function WorkspaceFileExplorer({
  sessionId,
  refreshKey,
  onBusyChange,
}: WorkspaceFileExplorerProps) {
  const [tree, setTree] = useState<ExplorerTreeNode[]>([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<ExplorerContentResult | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(true);
  const [svgView, setSvgView] = useState<"preview" | "source">("preview");
  const contentRequestRef = useRef(0);
  const treeRequestRef = useRef(0);
  const prevRefreshKeyRef = useRef(refreshKey);
  /** Opened-file content cache — skip re-fetch when switching tabs unless force/refresh. */
  const contentCacheRef = useRef(new Map<string, ExplorerContentResult>());

  const clearContentCache = useCallback(() => {
    contentCacheRef.current.clear();
  }, []);

  const reloadTree = useCallback(async () => {
    const requestId = ++treeRequestRef.current;
    setRootLoading(true);
    setRootError(null);

    try {
      const data = await fetchJson<ExplorerTreeResult>(
        `/api/sessions/${sessionId}/files`,
      );
      if (requestId !== treeRequestRef.current) {
        return;
      }
      setTree(data.tree);
      setTreeTruncated(data.truncated);

      // Keep previously expanded dirs that still exist after sync.
      const existingDirs = new Set<string>();
      collectDirPaths(data.tree, existingDirs);
      setExpanded((prev) => {
        const next = new Set<string>();
        for (const path of prev) {
          if (existingDirs.has(path)) {
            next.add(path);
          }
        }
        return next;
      });
    } catch (error) {
      if (requestId !== treeRequestRef.current) {
        return;
      }
      // Keep the last good tree on refresh failure; only first load stays empty.
      setRootError(
        error instanceof Error ? error.message : "Failed to load workspace",
      );
    } finally {
      if (requestId === treeRequestRef.current) {
        setRootLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    onBusyChange?.(rootLoading);
  }, [rootLoading, onBusyChange]);

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  // Initial load + sync after agent turn / manual refresh (one tree request).
  useEffect(() => {
    queueMicrotask(() => {
      void reloadTree();
    });
  }, [reloadTree, refreshKey]);

  const loadFile = useCallback(
    async (filePath: string, options?: { force?: boolean }) => {
      setSelectedPath(filePath);
      setContentError(null);

      if (!options?.force) {
        const cached = contentCacheRef.current.get(filePath);
        if (cached) {
          setContent(cached);
          setContentLoading(false);
          return;
        }
      }

      const requestId = ++contentRequestRef.current;
      setContentLoading(true);

      try {
        const data = await fetchJson<ExplorerContentResult>(
          `/api/sessions/${sessionId}/files/content?path=${encodeURIComponent(filePath)}`,
        );
        if (requestId !== contentRequestRef.current) {
          return;
        }
        contentCacheRef.current.set(filePath, data);
        setContent(data);
        setContentError(null);
      } catch (error) {
        if (requestId !== contentRequestRef.current) {
          return;
        }
        contentCacheRef.current.delete(filePath);
        // Keep the last good view when re-fetching the same file fails.
        setContent((prev) => (prev?.path === filePath ? prev : null));
        setContentError(
          error instanceof Error ? error.message : "Failed to read file",
        );
      } finally {
        if (requestId === contentRequestRef.current) {
          setContentLoading(false);
        }
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setSvgView("preview");
  }, [selectedPath]);

  // Invalidate cache + re-fetch open file when sandbox sync refreshKey bumps.
  useEffect(() => {
    const previous = prevRefreshKeyRef.current;
    prevRefreshKeyRef.current = refreshKey;
    if (previous === refreshKey) {
      return;
    }
    clearContentCache();
    if (!selectedPath) {
      return;
    }
    queueMicrotask(() => {
      void loadFile(selectedPath, { force: true });
    });
  }, [refreshKey, selectedPath, loadFile, clearContentCache]);

  const handleToggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const showingCurrentFile = Boolean(
    selectedPath && content?.path === selectedPath,
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Workspace
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {rootLoading && tree.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-zinc-400">Loading…</p>
          ) : (
            <>
              {rootError ? (
                <p className="px-3 py-2 text-[12px] text-red-500">{rootError}</p>
              ) : null}
              {tree.length === 0 && !rootError ? (
                <p className="px-3 py-2 text-[12px] text-zinc-400">
                  Workspace is empty
                </p>
              ) : tree.length > 0 ? (
                <ul className="m-0 list-none p-0">
                  {tree.map((node) => (
                    <FileTreeNode
                      key={node.path}
                      node={node}
                      depth={0}
                      expanded={expanded}
                      selectedPath={selectedPath}
                      onToggleDir={handleToggleDir}
                      onSelectFile={(path) => {
                        void loadFile(path);
                      }}
                    />
                  ))}
                </ul>
              ) : null}
              {treeTruncated ? (
                <p className="px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                  File tree truncated (node or depth limit reached)
                </p>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-white dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <p
            className="min-w-0 truncate font-mono text-[12px] text-zinc-700 dark:text-zinc-200"
            title={selectedPath ?? undefined}
          >
            {selectedPath ?? "Select a file to view (read-only)"}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {showingCurrentFile &&
            content?.kind === "image" &&
            content.mimeType === "image/svg+xml" &&
            content.encoding === "utf8" &&
            content.content ? (
              <div className="flex rounded-md border border-zinc-200 p-0.5 text-[11px] dark:border-zinc-700">
                <button
                  type="button"
                  onClick={() => setSvgView("preview")}
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    svgView === "preview"
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  }`}
                >
                  Preview
                </button>
                <button
                  type="button"
                  onClick={() => setSvgView("source")}
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    svgView === "source"
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  }`}
                >
                  Source
                </button>
              </div>
            ) : null}
            {contentLoading && showingCurrentFile && !rootLoading ? (
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300"
                aria-label="Refreshing file"
              />
            ) : null}
            {showingCurrentFile && content?.kind === "text" && content.truncated ? (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">
                Truncated {content.shownLines}/{content.totalLines} lines
              </span>
            ) : null}
            {showingCurrentFile &&
            content?.kind === "image" &&
            content.truncated ? (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">
                Too large to preview
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!selectedPath ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-400">
              Open a source file from the left
            </div>
          ) : contentLoading && !showingCurrentFile ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
              Reading…
            </div>
          ) : contentError && !showingCurrentFile ? (
            <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">
              {contentError}
            </p>
          ) : content?.kind === "image" &&
            !(svgView === "source" && content.encoding === "utf8") ? (
            <>
              {contentError && showingCurrentFile ? (
                <p className="px-4 py-2 text-[12px] text-red-600 dark:text-red-400">
                  {contentError}
                </p>
              ) : null}
              <ExplorerImagePreview result={content} />
            </>
          ) : content?.binary || content?.kind === "binary" ? (
            <p className="px-4 py-3 text-sm text-zinc-500">
              Binary or non-text file; preview is not supported.
            </p>
          ) : (
            <>
              {contentError && showingCurrentFile ? (
                <p className="px-4 py-2 text-[12px] text-red-600 dark:text-red-400">
                  {contentError}
                </p>
              ) : null}
              <CodeHighlight
                code={content?.content ?? ""}
                filePath={selectedPath}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
