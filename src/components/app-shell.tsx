"use client";

import { Loader2, Plus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  useCreateSessionMutation,
  useInvalidateSessionDetail,
  useRefetchSessionOnActivate,
  useSessionQuery,
  useSessionsQuery,
  useSyncSessionSummary,
} from "@/lib/session/queries";
import type { AppTestLatestStatus } from "@/lib/browser-run/run-status";
import { useWorkspaceLayout } from "@/hooks/use-workspace-layout";
import {
  isFinishedRuntimeRunStatus,
  resolveLiveRunState,
} from "@/lib/session/runtime-projection";
import { useInvalidateSessionRuntime, useSessionRuntime } from "@/lib/session/runtime-query";
import { cn } from "@/lib/utils";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/workspace-layout";

import { AuthUserBar } from "./auth-user-bar";
import { Chat } from "./chat";
import { MvpNoticeCarousel } from "./mvp-notice-carousel";
import { PreviewPanel } from "./preview-panel";
import { ResizeHandle } from "./resize-handle";
import { SessionSidebar } from "./session-sidebar";
import { WorkspaceMainSplit } from "./workspace-main-split";

const GITHUB_REPO_URL = "https://github.com/1nFrastr/baby-lovable";

/** Lucide dropped brand icons; keep a minimal GitHub mark here. */
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23.96-.27 1.98-.4 3-.4s2.04.13 3 .4c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.61-.01 2.91-.01 3.3 0 .32.22.7.82.58C20.56 21.8 24 17.3 24 12 24 5.37 18.63 0 12 0z" />
    </svg>
  );
}

function SessionWorkspaceLoading({
  label = "Loading session…",
  chatRatio,
  isDragging,
  onResize,
  onDragStart,
  onDragEnd,
  onNudge,
}: {
  label?: string;
  chatRatio: number;
  isDragging: boolean;
  onResize: (clientX: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onNudge: (direction: -1 | 1) => void;
}) {
  return (
    <div role="status" aria-label={label} className="h-full min-h-0">
      <WorkspaceMainSplit
        chatRatio={chatRatio}
        isDragging={isDragging}
        onResize={onResize}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onNudge={onNudge}
        left={
          <div className="flex h-full min-w-0 items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
              <span>{label}</span>
            </div>
          </div>
        }
        right={
          <section className="flex h-full min-w-0 flex-col border-l border-zinc-200 dark:border-zinc-800">
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Preview
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Connecting to preview
              </p>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-100 dark:bg-zinc-950">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
            </div>
          </section>
        }
      />
    </div>
  );
}

export function AppShell() {
  const router = useRouter();
  const params = useParams();
  const activeSessionId =
    typeof params.sessionId === "string" ? params.sessionId : null;
  const [isNavPending, startTransition] = useTransition();

  const sessionsQuery = useSessionsQuery();
  const sessionQuery = useSessionQuery(activeSessionId);
  const runtimeQuery = useSessionRuntime(activeSessionId);
  const createSessionMutation = useCreateSessionMutation();
  const invalidateSessionDetail = useInvalidateSessionDetail();
  const invalidateRuntime = useInvalidateSessionRuntime();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActivatingSession, setIsActivatingSession] = useState(false);
  /** Optimistic target while router/API lag (weak network). */
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  /** Covers create API + post-success navigation gap (mutation isPending ends first). */
  const [isCreateInFlight, setIsCreateInFlight] = useState(false);
  const [chatAppTest, setChatAppTest] = useState<AppTestLatestStatus | null>(
    null,
  );
  /** False until Chat reports extract (incl. null) so Live View can ignore hydrate. */
  const [chatAppTestReady, setChatAppTestReady] = useState(false);
  const {
    containerRef,
    mainRef,
    isDragging,
    sidebarCollapsed,
    sidebarWidth,
    expandedSidebarWidth,
    chatRatio,
    beginDrag,
    endDrag,
    resizeSidebar,
    resizeChat,
    toggleCollapsed,
    nudgeSidebar,
    nudgeChat,
  } = useWorkspaceLayout();

  const sessions = sessionsQuery.data?.sessions ?? [];
  const activeSession = sessionQuery.data?.session ?? null;
  const activeSummary = sessions.find((session) => session.id === activeSessionId);
  /** Prefer newer of runtime projection vs session row (publish is best-effort). */
  const liveRun = resolveLiveRunState(
    runtimeQuery.data?.projection.run,
    activeSession
      ? {
          runStatus: activeSession.runStatus,
          updatedAt: activeSession.updatedAt,
        }
      : null,
  );
  const liveRunStatus = liveRun.runStatus;
  const liveRunUpdatedAt = liveRun.updatedAt;

  useRefetchSessionOnActivate(activeSessionId);
  useSyncSessionSummary(activeSession);

  const prevRuntimeRunStatus = useRef<string | undefined>(undefined);

  useEffect(() => {
    setChatAppTest(null);
    setChatAppTestReady(false);
    prevRuntimeRunStatus.current = undefined;
  }, [activeSessionId]);

  // Runtime Realtime can flip run→done before onChatEnd's detail invalidate lands.
  // Refetch durable authoritative messages immediately.
  useEffect(() => {
    const status = runtimeQuery.data?.projection.run?.status;
    const prev = prevRuntimeRunStatus.current;
    prevRuntimeRunStatus.current = status;

    if (activeSessionId && prev === "running" && status && isFinishedRuntimeRunStatus(status)) {
      invalidateSessionDetail(activeSessionId);
    }
  }, [
    activeSessionId,
    invalidateSessionDetail,
    runtimeQuery.data?.projection.run?.status,
  ]);

  const handleAppTestStatus = useCallback(
    (status: AppTestLatestStatus | null) => {
      setChatAppTest(status);
      setChatAppTestReady(true);
    },
    [],
  );

  useEffect(() => {
    if (!activeSessionId) {
      setIsActivatingSession(false);
      return;
    }

    setIsActivatingSession(true);
  }, [activeSessionId]);

  useEffect(() => {
    if (!sessionQuery.isFetching) {
      setIsActivatingSession(false);
    }
  }, [sessionQuery.isFetching]);

  // Clear optimistic navigation once the URL matches the intended session.
  useEffect(() => {
    if (pendingSessionId != null && pendingSessionId === activeSessionId) {
      setPendingSessionId(null);
      setIsCreateInFlight(false);
    }
  }, [activeSessionId, pendingSessionId]);

  const isCreating = isCreateInFlight || createSessionMutation.isPending;
  const isSwitchingSession =
    pendingSessionId != null && pendingSessionId !== activeSessionId;
  const isBootstrapping = sessionsQuery.isPending && sessions.length === 0;
  const cacheMissingMessages =
    activeSummary != null &&
    activeSummary.messageCount > 0 &&
    (activeSession?.messages.length ?? 0) < activeSummary.messageCount;
  const isSessionReady =
    activeSessionId != null &&
    activeSession?.id === activeSessionId &&
    !cacheMissingMessages &&
    !(isActivatingSession && sessionQuery.isFetching);
  const showWorkspaceLoading =
    isCreating ||
    isSwitchingSession ||
    isNavPending ||
    (activeSessionId != null && !isSessionReady);
  const workspaceLoadingLabel = isCreating
    ? "Creating session…"
    : isSwitchingSession || isNavPending
      ? "Switching session…"
      : "Loading session…";

  const loadError =
    actionError ??
    (sessionsQuery.isError
      ? sessionsQuery.error instanceof Error
        ? sessionsQuery.error.message
        : "Failed to load sessions"
      : null) ??
    (sessionQuery.isError
      ? sessionQuery.error instanceof Error
        ? sessionQuery.error.message
        : "Failed to load session"
      : null);

  const handleSelectSession = (sessionId: string) => {
    if (
      sessionId === activeSessionId ||
      sessionId === pendingSessionId ||
      isCreating
    ) {
      return;
    }

    setActionError(null);
    setPendingSessionId(sessionId);
    startTransition(() => {
      router.push(`/sessions/${sessionId}`);
    });
  };

  const handleCreateSession = async () => {
    if (isCreating || isSwitchingSession) {
      return;
    }

    setActionError(null);
    setPendingSessionId(null);
    setIsCreateInFlight(true);

    try {
      const { session } = await createSessionMutation.mutateAsync();
      setPendingSessionId(session.id);
      startTransition(() => {
        router.push(`/sessions/${session.id}`);
      });
    } catch (error) {
      setPendingSessionId(null);
      setIsCreateInFlight(false);
      setActionError(
        error instanceof Error ? error.message : "Failed to create session",
      );
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="flex shrink-0 items-center gap-3">
          <img
            src="/brand/icon.png"
            alt=""
            width={36}
            height={36}
            className="rounded-lg"
          />
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              BabyLovable
            </h1>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open repository on GitHub"
              title="GitHub"
              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[10px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <GitHubIcon className="h-3.5 w-3.5" />
              Repo
            </a>
          </div>
        </div>

        <MvpNoticeCarousel className="hidden sm:block" />

        <div className="ml-auto flex shrink-0 items-center gap-3 sm:ml-0">
          <AuthUserBar />
        </div>
      </header>

      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "relative h-full shrink-0 overflow-hidden",
            !isDragging && "transition-[width] duration-200 ease-out",
          )}
          style={{ width: sidebarWidth }}
        >
          <SessionSidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            pendingSessionId={pendingSessionId}
            onSelect={handleSelectSession}
            onCreate={() => {
              void handleCreateSession();
            }}
            isCreating={isCreating}
            isSwitching={isSwitchingSession || isNavPending}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        </div>
        <ResizeHandle
          label="Resize sessions sidebar"
          valueNow={expandedSidebarWidth}
          valueMin={SIDEBAR_MIN_WIDTH}
          valueMax={SIDEBAR_MAX_WIDTH}
          valueText={
            sidebarCollapsed
              ? "Sessions sidebar collapsed"
              : `Sessions sidebar ${expandedSidebarWidth}px`
          }
          onDrag={resizeSidebar}
          onDragStart={beginDrag}
          onDragEnd={endDrag}
          onNudge={(direction) => nudgeSidebar(direction * 16)}
          onDoubleClick={toggleCollapsed}
        />

        <main ref={mainRef} className="min-w-0 flex-1 overflow-hidden">
          {isBootstrapping ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Loading sessions…
            </div>
          ) : loadError && !isCreating && !isSwitchingSession ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">
                {loadError}
              </p>
              <button
                type="button"
                onClick={() => router.push("/sessions")}
                className="rounded-xl border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Back to sessions
              </button>
            </div>
          ) : showWorkspaceLoading || (activeSessionId != null && !activeSession) ? (
            <SessionWorkspaceLoading
              label={workspaceLoadingLabel}
              chatRatio={chatRatio}
              isDragging={isDragging}
              onResize={resizeChat}
              onDragStart={beginDrag}
              onDragEnd={endDrag}
              onNudge={(direction) => nudgeChat(direction * 0.02)}
            />
          ) : !activeSessionId || !activeSession ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-lg text-zinc-700 dark:text-zinc-200">
                Create your first project
              </p>
              <button
                type="button"
                onClick={() => {
                  void handleCreateSession();
                }}
                disabled={isCreating}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                    Creating…
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" strokeWidth={2} />
                    New Project
                  </>
                )}
              </button>
            </div>
          ) : (
            <WorkspaceMainSplit
              chatRatio={chatRatio}
              isDragging={isDragging}
              onResize={resizeChat}
              onDragStart={beginDrag}
              onDragEnd={endDrag}
              onNudge={(direction) => nudgeChat(direction * 0.02)}
              left={
                <Chat
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  messages={activeSession.messages}
                  runStatus={liveRunStatus}
                  runUpdatedAt={liveRunUpdatedAt}
                  onSessionRefresh={() => {
                    invalidateSessionDetail(activeSessionId);
                    invalidateRuntime(activeSessionId);
                  }}
                  onAppTestStatus={handleAppTestStatus}
                />
              }
              right={
                <PreviewPanel
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  runtimeProjection={runtimeQuery.data?.projection ?? null}
                  runtimeLoading={
                    runtimeQuery.isPending ||
                    (runtimeQuery.isFetching && !runtimeQuery.data)
                  }
                  runtimeError={
                    runtimeQuery.isError && !runtimeQuery.data
                      ? runtimeQuery.error instanceof Error
                        ? runtimeQuery.error.message
                        : "Failed to load session runtime"
                      : null
                  }
                  chatAppTest={chatAppTest}
                  chatAppTestReady={chatAppTestReady}
                />
              }
            />
          )}
        </main>
      </div>
    </div>
  );
}
