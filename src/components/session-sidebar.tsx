"use client";

import { Loader2, PanelLeft, PanelLeftClose, Plus } from "lucide-react";

import type { SessionSummary } from "@/lib/session/types";
import { isActiveRunStatus } from "@/lib/session/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** Optimistic highlight while route/API catches up (weak network). */
  pendingSessionId?: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  isCreating?: boolean;
  isSwitching?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
  collapsed = false,
  onToggleCollapsed,
}: SessionSidebarProps) {
  const highlightedId = pendingSessionId ?? activeSessionId;
  const navigationBusy = isCreating || isSwitching;

  if (collapsed) {
    return (
      <aside
        className="flex h-full w-full flex-col items-center border-r border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-950"
        aria-label="Sessions sidebar"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Expand sessions sidebar"
              aria-expanded={false}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-600 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <PanelLeft className="h-4 w-4" strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Expand sessions sidebar</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCreate}
              disabled={navigationBusy}
              aria-busy={isCreating}
              aria-label="New session"
              className="mt-2 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {isCreating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <Plus className="h-4 w-4" strokeWidth={2} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">New session</TooltipContent>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full w-full flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
      aria-label="Sessions sidebar"
    >
      <div className="border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Sessions
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onCreate}
              disabled={navigationBusy}
              aria-busy={isCreating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {isCreating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                  Creating…
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                  New
                </>
              )}
            </button>
            {onToggleCollapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleCollapsed}
                    aria-label="Collapse sessions sidebar"
                    aria-expanded={true}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  >
                    <PanelLeftClose className="h-4 w-4" strokeWidth={2} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Collapse sessions sidebar</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {sessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            No project sessions yet
            <br />
            Click New to start building
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
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {session.id}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                      {formatRelativeTime(session.updatedAt)}
                    </p>
                    {isPendingTarget ? (
                      <Loader2
                        className="h-3 w-3 shrink-0 animate-spin text-zinc-400"
                        strokeWidth={2}
                      />
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
