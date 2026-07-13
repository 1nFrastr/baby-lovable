"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionDraft } from "@/lib/session/draft-store";
import {
  isActiveRunStatus,
  type Session,
  type SessionSummary,
} from "@/lib/session/types";

import { Chat } from "./chat";
import { PreviewPanel } from "./preview-panel";
import { SessionSidebar } from "./session-sidebar";
import { AuthUserBar } from "./auth-user-bar";

const POLL_ACTIVE_SESSION_MS = 800;

interface AppShellProps {
  /** When set, bootstrap loads this session (from `/sessions/[sessionId]`). */
  initialSessionId?: string;
}

interface SessionResponse {
  session: Session;
  draft: SessionDraft | null;
}

function patchSessionSummary(
  summaries: SessionSummary[],
  session: Session,
): SessionSummary[] {
  const next: SessionSummary = {
    id: session.id,
    userId: session.userId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastRunId: session.lastRunId,
    runStatus: session.runStatus,
    sandboxMode: session.sandboxMode,
    messageCount: session.messages.length,
  };

  const index = summaries.findIndex((item) => item.id === session.id);
  if (index === -1) {
    return [next, ...summaries];
  }

  return summaries.map((item, itemIndex) =>
    itemIndex === index ? next : item,
  );
}

export function AppShell({ initialSessionId }: AppShellProps) {
  const router = useRouter();
  const activeSessionId = initialSessionId ?? null;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [activeDraft, setActiveDraft] = useState<SessionDraft | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRequestIdRef = useRef(0);

  const loadSessions = useCallback(async () => {
    const response = await fetch("/api/sessions");
    if (!response.ok) {
      throw new Error("Failed to load sessions");
    }

    const data = (await response.json()) as { sessions: SessionSummary[] };
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    const requestId = ++loadRequestIdRef.current;

    const response = await fetch(`/api/sessions/${sessionId}`);
    if (response.status === 404) {
      throw new Error("Session not found");
    }
    if (!response.ok) {
      throw new Error("Failed to load session");
    }

    const data = (await response.json()) as SessionResponse;
    if (requestId !== loadRequestIdRef.current) {
      return data.session;
    }

    setActiveSession(data.session);
    setActiveDraft(data.draft);
    setSessions((current) => patchSessionSummary(current, data.session));
    return data.session;
  }, []);

  const refreshActiveSession = useCallback(async () => {
    if (!activeSessionId) {
      return;
    }

    try {
      await loadSession(activeSessionId);
    } catch {
      // Non-fatal — workflow may still be persisting.
    }
  }, [activeSessionId, loadSession]);

  const isSessionReady =
    activeSessionId != null && activeSession?.id === activeSessionId;

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        setLoadError(null);
        await loadSessions();
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to bootstrap app",
          );
        }
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    let cancelled = false;

    void loadSession(activeSessionId).catch((error) => {
      if (!cancelled) {
        setLoadError(
          error instanceof Error ? error.message : "Failed to load session",
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, loadSession]);

  useEffect(() => {
    if (!activeSessionId || !isSessionReady) {
      return;
    }

    if (!isActiveRunStatus(activeSession!.runStatus)) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshActiveSession();
    }, POLL_ACTIVE_SESSION_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeSession, activeSessionId, isSessionReady, refreshActiveSession]);

  const handleSelectSession = (sessionId: string) => {
    if (sessionId === activeSessionId) {
      return;
    }

    setLoadError(null);
    router.push(`/sessions/${sessionId}`);
  };

  const handleCreateSession = async () => {
    setIsCreating(true);
    setLoadError(null);

    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error("Failed to create session");
      }

      const data = (await response.json()) as { session: Session };
      setSessions((current) => patchSessionSummary(current, data.session));
      router.push(`/sessions/${data.session.id}`);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Failed to create session",
      );
    } finally {
      setIsCreating(false);
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
          isCreating={isCreating}
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
                baby-lovable 会在本地 `.baby-lovable/sessions/` 目录中从
                Next.js starter 模板初始化项目，并持久化你的修改。
              </p>
              <button
                type="button"
                onClick={() => {
                  void handleCreateSession();
                }}
                disabled={isCreating}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isCreating ? "Creating…" : "New Project"}
              </button>
            </div>
          ) : !isSessionReady ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Loading session…
            </div>
          ) : (
            <div className="flex h-full min-h-0">
              <div className="min-w-0 flex-1">
                <Chat
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  messages={activeSession.messages}
                  draft={activeDraft?.message ?? null}
                  runStatus={activeSession.runStatus}
                  onSessionRefresh={() => {
                    void refreshActiveSession();
                  }}
                />
              </div>
              <PreviewPanel key={activeSessionId} sessionId={activeSessionId} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
