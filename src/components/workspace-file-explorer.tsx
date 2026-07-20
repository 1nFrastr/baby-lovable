"use client";

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
        <span className="w-3 shrink-0 text-[10px] text-zinc-400" aria-hidden>
          {node.isDir ? (isOpen ? "▾" : "▸") : " "}
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
              （空）
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
  const contentRequestRef = useRef(0);
  const prevRefreshKeyRef = useRef(refreshKey);

  const reloadTree = useCallback(async () => {
    setRootLoading(true);
    setRootError(null);

    try {
      const data = await fetchJson<ExplorerTreeResult>(
        `/api/sessions/${sessionId}/files`,
      );
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
      setTree([]);
      setTreeTruncated(false);
      setRootError(
        error instanceof Error ? error.message : "Failed to load workspace",
      );
    } finally {
      setRootLoading(false);
    }
  }, [sessionId]);

  // Initial load + sync after agent turn / manual refresh (one tree request).
  useEffect(() => {
    queueMicrotask(() => {
      void reloadTree();
    });
  }, [reloadTree, refreshKey]);

  const loadFile = useCallback(
    async (filePath: string) => {
      const requestId = ++contentRequestRef.current;
      setSelectedPath(filePath);
      setContentLoading(true);
      setContentError(null);

      try {
        const data = await fetchJson<ExplorerContentResult>(
          `/api/sessions/${sessionId}/files/content?path=${encodeURIComponent(filePath)}`,
        );
        if (requestId !== contentRequestRef.current) {
          return;
        }
        setContent(data);
      } catch (error) {
        if (requestId !== contentRequestRef.current) {
          return;
        }
        setContent(null);
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

  // Re-fetch open file only when sandbox sync refreshKey bumps.
  useEffect(() => {
    const previous = prevRefreshKeyRef.current;
    prevRefreshKeyRef.current = refreshKey;
    if (previous === refreshKey || !selectedPath) {
      return;
    }
    queueMicrotask(() => {
      void loadFile(selectedPath);
    });
  }, [refreshKey, selectedPath, loadFile]);

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

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Workspace
          </p>
          <button
            type="button"
            onClick={() => {
              void reloadTree();
              if (selectedPath) {
                void loadFile(selectedPath);
              }
            }}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="从 sandbox 重新同步完整文件树"
          >
            刷新
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {rootLoading && tree.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-zinc-400">加载中…</p>
          ) : rootError ? (
            <p className="px-3 py-2 text-[12px] text-red-500">{rootError}</p>
          ) : (
            <>
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
                {!rootLoading && tree.length === 0 ? (
                  <li className="px-3 py-2 text-[12px] text-zinc-400">
                    工作区为空
                  </li>
                ) : null}
              </ul>
              {treeTruncated ? (
                <p className="px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                  文件树已截断（节点数或深度达到上限）
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
            {selectedPath ?? "选择一个文件查看（只读）"}
          </p>
          {content && !content.binary && content.truncated ? (
            <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300">
              已截断 {content.shownLines}/{content.totalLines} 行
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!selectedPath ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-400">
              从左侧打开源码文件
            </div>
          ) : contentLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
              读取中…
            </div>
          ) : contentError ? (
            <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">
              {contentError}
            </p>
          ) : content?.binary ? (
            <p className="px-4 py-3 text-sm text-zinc-500">
              二进制或非文本文件，暂不支持预览。
            </p>
          ) : (
            <CodeHighlight
              code={content?.content ?? ""}
              filePath={selectedPath}
            />
          )}
        </div>
      </div>
    </div>
  );
}
