"use client";

import { History, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { VersionHistoryItem } from "@/lib/git/types";

interface VersionHistoryPanelProps {
  sessionId: string;
  /** Bump when sourceControl flips (e.g. syncing → synced) to refetch. */
  refreshKey: number;
}

interface VersionsResponse {
  versions: VersionHistoryItem[];
  available: boolean;
  error?: string;
}

const STATUS_LABEL: Record<
  VersionHistoryItem["status"],
  { text: string; className: string }
> = {
  pending: {
    text: "排队中",
    className: "text-amber-700 dark:text-amber-300",
  },
  syncing: {
    text: "保存中",
    className: "text-sky-700 dark:text-sky-300",
  },
  synced: {
    text: "已保存",
    className: "text-emerald-700 dark:text-emerald-300",
  },
  no_changes: {
    text: "无变更",
    className: "text-zinc-500 dark:text-zinc-400",
  },
  error: {
    text: "失败",
    className: "text-red-700 dark:text-red-300",
  },
  conflict: {
    text: "冲突",
    className: "text-red-700 dark:text-red-300",
  },
};

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function VersionHistoryPanel({
  sessionId,
  refreshKey,
}: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<VersionHistoryItem[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/versions`);
      const data = (await response.json().catch(() => null)) as
        | VersionsResponse
        | null;
      if (!response.ok) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      setVersions(data?.versions ?? []);
      setAvailable(data?.available !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
        <History className="h-5 w-5 opacity-50" strokeWidth={1.75} />
        <p>版本历史仅在 Daytona 模式下可用</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          每轮对话结束自动存档（只读）
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <RefreshCw
            className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
            strokeWidth={2}
          />
          刷新
        </button>
      </div>

      {error ? (
        <div className="px-4 py-6 text-center text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : loading && versions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
          加载中…
        </div>
      ) : versions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          <History className="h-5 w-5 opacity-50" strokeWidth={1.75} />
          <p>还没有版本记录</p>
          <p className="text-xs">完成一轮对话后会出现在这里</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {versions.map((item) => {
            const status = STATUS_LABEL[item.status] ?? STATUS_LABEL.pending;
            return (
              <li
                key={item.runId}
                className="border-b border-zinc-100 px-3 py-3 dark:border-zinc-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                      {item.commitMessage || "（无说明）"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                      {formatTime(item.createdAt)}
                      {item.shortSha ? (
                        <span className="ml-2 font-mono">{item.shortSha}</span>
                      ) : null}
                    </p>
                    {item.error ? (
                      <p
                        className="mt-1 line-clamp-2 text-[11px] text-red-600 dark:text-red-400"
                        title={item.error}
                      >
                        {item.error}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 text-[10px] font-medium uppercase tracking-wide ${status.className}`}
                  >
                    {status.text}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
