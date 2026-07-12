"use client";

import type { SessionSummary } from "@/lib/session/types";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  isCreating?: boolean;
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  isCreating = false,
}: SessionSidebarProps) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Sessions
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Next.js builder projects
            </p>
          </div>
          <button
            type="button"
            onClick={onCreate}
            disabled={isCreating}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isCreating ? "Creating…" : "+ New"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {sessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            还没有项目会话
            <br />
            点击 New 开始构建
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;

              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                    isActive
                      ? "border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40"
                      : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                  }`}
                >
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {session.title}
                  </p>
                  <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {session.id}
                  </p>
                  <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                    {formatRelativeTime(session.updatedAt)}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
