"use client";

import type { SessionSummary } from "@/lib/session/types";
import { isActiveRunStatus } from "@/lib/session/types";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** Optimistic highlight while route/API catches up (weak network). */
  pendingSessionId?: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  isCreating?: boolean;
  isSwitching?: boolean;
}

function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-200 ${className ?? "h-3.5 w-3.5"}`}
      aria-hidden="true"
    />
  );
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
  pendingSessionId = null,
  onSelect,
  onCreate,
  isCreating = false,
  isSwitching = false,
}: SessionSidebarProps) {
  const highlightedId = pendingSessionId ?? activeSessionId;
  const navigationBusy = isCreating || isSwitching;

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
            disabled={navigationBusy}
            aria-busy={isCreating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isCreating ? (
              <>
                <Spinner className="h-3 w-3 border-white/40 border-t-white" />
                Creating…
              </>
            ) : (
              "+ New"
            )}
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
              const isHighlighted = session.id === highlightedId;
              const isPendingTarget =
                pendingSessionId != null && session.id === pendingSessionId;

              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelect(session.id)}
                  disabled={navigationBusy && !isPendingTarget}
                  aria-current={isHighlighted ? "page" : undefined}
                  aria-busy={isPendingTarget || undefined}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors disabled:opacity-60 ${
                    isHighlighted
                      ? "border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40"
                      : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {session.title}
                      {isActiveRunStatus(session.runStatus) ? (
                        <span className="ml-2 inline-block h-2 w-2 rounded-full bg-blue-500 align-middle" />
                      ) : null}
                    </p>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        session.sandboxMode === "daytona"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}
                    >
                      {session.sandboxMode === "daytona" ? "daytona" : "local"}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {session.id}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                      {formatRelativeTime(session.updatedAt)}
                    </p>
                    {isPendingTarget ? (
                      <Spinner className="h-3 w-3 shrink-0" />
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
