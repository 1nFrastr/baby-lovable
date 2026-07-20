"use client";

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
import { toSessionRunStatus } from "@/lib/session/runtime-projection";
import { useSessionRuntime } from "@/lib/session/runtime-query";

import { AuthUserBar } from "./auth-user-bar";
import { Chat } from "./chat";
import { MvpNoticeCarousel } from "./mvp-notice-carousel";
import { PreviewPanel } from "./preview-panel";
import { SessionSidebar } from "./session-sidebar";

const GITHUB_REPO_URL = "https://github.com/1nFrastr/baby-lovable";

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
  label = "正在载入会话…",
}: {
  label?: string;
}) {
  return (
    <div
      className="flex h-full min-h-0"
      role="status"
      aria-label={label}
    >
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
          <span>{label}</span>
        </div>
      </div>
      <section className="flex min-w-0 flex-1 flex-col border-l border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Preview
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            正在连接预览环境
          </p>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-100 dark:bg-zinc-950">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
        </div>
      </section>
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

  const sessions = sessionsQuery.data?.sessions ?? [];
  const sandboxMode = sessionsQuery.data?.features.sandboxMode ?? "local";
  const activeSession = sessionQuery.data?.session ?? null;
  const activeDraft = sessionQuery.data?.draft ?? null;
  const activeSummary = sessions.find((session) => session.id === activeSessionId);
  /** Live run status from runtime projection; fall back to session detail. */
  const liveRunStatus = runtimeQuery.data?.projection.run
    ? toSessionRunStatus(runtimeQuery.data.projection.run.status)
    : (activeSession?.runStatus ?? "idle");

  useRefetchSessionOnActivate(activeSessionId);
  useSyncSessionSummary(activeSession);

  const prevRuntimeRunStatus = useRef<string | undefined>(undefined);

  useEffect(() => {
    setChatAppTest(null);
    setChatAppTestReady(false);
    prevRuntimeRunStatus.current = undefined;
  }, [activeSessionId]);

  // Runtime SSE can flip run→done before onChatEnd's detail invalidate lands.
  // Refetch session.json as soon as the projection leaves "running".
  useEffect(() => {
    const status = runtimeQuery.data?.projection.run?.status;
    const prev = prevRuntimeRunStatus.current;
    prevRuntimeRunStatus.current = status;

    if (
      activeSessionId &&
      prev === "running" &&
      (status === "done" || status === "error" || status === "idle")
    ) {
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
    ? "正在创建会话…"
    : isSwitchingSession || isNavPending
      ? "正在切换会话…"
      : "正在载入会话…";

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
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              baby-lovable
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              WorkflowAgent runtime for Next.js app generation
            </p>
          </div>
        </div>

        <MvpNoticeCarousel className="hidden sm:block" />

        <div className="flex shrink-0 items-center gap-3">
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在 GitHub 打开仓库"
            title="GitHub"
            className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <GitHubIcon className="h-5 w-5" />
          </a>
          <AuthUserBar />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
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
        />

        <main className="min-w-0 flex-1">
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
                返回会话列表
              </button>
            </div>
          ) : showWorkspaceLoading || (activeSessionId != null && !activeSession) ? (
            <SessionWorkspaceLoading label={workspaceLoadingLabel} />
          ) : !activeSessionId || !activeSession ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-lg text-zinc-700 dark:text-zinc-200">
                创建第一个项目会话
              </p>
              <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
                {sandboxMode === "daytona"
                  ? "Daytona 模式会在远程沙箱内部文件系统中从 Next.js starter 模板初始化项目。"
                  : "baby-lovable 会在本地 `.baby-lovable/sessions/` 目录中从 Next.js starter 模板初始化项目，并持久化你的修改。"}
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
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Creating…
                  </>
                ) : (
                  "New Project"
                )}
              </button>
            </div>
          ) : (
            <div className="flex h-full min-h-0">
              <div className="min-w-0 flex-1">
                <Chat
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  messages={activeSession.messages}
                  draft={activeDraft?.message ?? null}
                  runStatus={liveRunStatus}
                  sandboxMode={activeSession.sandboxMode}
                  onSessionRefresh={() => {
                    invalidateSessionDetail(activeSessionId);
                  }}
                  onAppTestStatus={handleAppTestStatus}
                />
              </div>
              <PreviewPanel
                key={activeSessionId}
                sessionId={activeSessionId}
                sandboxMode={activeSession.sandboxMode}
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
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
