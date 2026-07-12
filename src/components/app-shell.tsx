"use client";

import { useCallback, useEffect, useState } from "react";

import type { Session, SessionSummary } from "@/lib/session/types";

import { Chat } from "./chat";
import { SessionSidebar } from "./session-sidebar";

export function AppShell() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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
    const response = await fetch(`/api/sessions/${sessionId}`);
    if (!response.ok) {
      throw new Error("Failed to load session");
    }

    const data = (await response.json()) as { session: Session };
    setActiveSession(data.session);
    return data.session;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        setLoadError(null);
        const nextSessions = await loadSessions();
        if (cancelled) {
          return;
        }

        if (nextSessions.length > 0) {
          const firstSessionId = nextSessions[0].id;
          setActiveSessionId(firstSessionId);
          await loadSession(firstSessionId);
        }
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
  }, [loadSession, loadSessions]);

  const handleSelectSession = async (sessionId: string) => {
    setActiveSessionId(sessionId);
    setLoadError(null);

    try {
      await loadSession(sessionId);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Failed to load session",
      );
    }
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
      const nextSessions = await loadSessions();
      setSessions(nextSessions);
      setActiveSessionId(data.session.id);
      setActiveSession(data.session);
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
      <header className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          baby-lovable
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          WorkflowAgent runtime for Next.js app generation
        </p>
      </header>

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={(sessionId) => {
            void handleSelectSession(sessionId);
          }}
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
            <div className="flex h-full items-center justify-center px-6 text-sm text-red-600 dark:text-red-400">
              {loadError}
            </div>
          ) : !activeSession ? (
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
          ) : (
            <Chat
              key={activeSession.id}
              sessionId={activeSession.id}
              initialMessages={activeSession.messages}
            />
          )}
        </main>
      </div>
    </div>
  );
}
