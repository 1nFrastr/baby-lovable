"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

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

import { Chat } from "./chat";
import { PreviewPanel } from "./preview-panel";
import { SessionSidebar } from "./session-sidebar";
import { AuthUserBar } from "./auth-user-bar";

function SessionWorkspaceLoading() {
  return (
    <div
      className="flex h-full min-h-0"
      role="status"
      aria-label="正在载入会话"
    >
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
          <span>正在载入会话…</span>
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

  const sessionsQuery = useSessionsQuery();
  const sessionQuery = useSessionQuery(activeSessionId);
  const runtimeQuery = useSessionRuntime(activeSessionId);
  const createSessionMutation = useCreateSessionMutation();
  const invalidateSessionDetail = useInvalidateSessionDetail();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActivatingSession, setIsActivatingSession] = useState(false);
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
    if (sessionId === activeSessionId) {
      return;
    }

    setActionError(null);
    router.push(`/sessions/${sessionId}`);
  };

  const handleCreateSession = async () => {
    setActionError(null);

    try {
      const { session } = await createSessionMutation.mutateAsync();
      router.push(`/sessions/${session.id}`);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to create session",
      );
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            baby-lovable
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            WorkflowAgent runtime for Next.js app generation
          </p>
        </div>
        <AuthUserBar />
      </header>

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={handleSelectSession}
          onCreate={() => {
            void handleCreateSession();
          }}
          isCreating={createSessionMutation.isPending}
        />

        <main className="min-w-0 flex-1">
          {isBootstrapping ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Loading sessions…
            </div>
          ) : loadError ? (
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
          ) : !activeSessionId ? (
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
                disabled={createSessionMutation.isPending}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {createSessionMutation.isPending ? "Creating…" : "New Project"}
              </button>
            </div>
          ) : !isSessionReady ? (
            <SessionWorkspaceLoading />
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
