"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type { SessionDraft } from "@/lib/session/draft-store";
import {
  isActiveRunStatus,
  type Session,
  type SessionSummary,
} from "@/lib/session/types";

const POLL_ACTIVE_SESSION_MS = 800;

export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  detail: (sessionId: string) =>
    [...sessionKeys.all, "detail", sessionId] as const,
};

export interface SessionDetailData {
  session: Session;
  draft: SessionDraft | null;
}

function sessionToSummary(session: Session): SessionSummary {
  return {
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
}

export function patchSessionSummary(
  summaries: SessionSummary[],
  session: Session,
): SessionSummary[] {
  const next = sessionToSummary(session);
  const index = summaries.findIndex((item) => item.id === session.id);
  if (index === -1) {
    return [next, ...summaries];
  }

  return summaries.map((item, itemIndex) =>
    itemIndex === index ? next : item,
  );
}

async function fetchSessions(): Promise<SessionSummary[]> {
  const response = await fetch("/api/sessions");
  if (!response.ok) {
    throw new Error("Failed to load sessions");
  }

  const data = (await response.json()) as { sessions: SessionSummary[] };
  return data.sessions;
}

async function fetchSessionDetail(
  sessionId: string,
): Promise<SessionDetailData> {
  const response = await fetch(`/api/sessions/${sessionId}`);
  if (response.status === 404) {
    throw new Error("Session not found");
  }
  if (!response.ok) {
    throw new Error("Failed to load session");
  }

  return (await response.json()) as SessionDetailData;
}

export function useSessionsQuery() {
  return useQuery({
    queryKey: sessionKeys.lists(),
    queryFn: fetchSessions,
  });
}

export function useSessionQuery(sessionId: string | null) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId ?? ""),
    queryFn: () => fetchSessionDetail(sessionId!),
    enabled: Boolean(sessionId),
    // Detail must always revalidate when revisiting — cached empty messages
    // after the first chat turn caused blank history on session switch-back.
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const runStatus = query.state.data?.session.runStatus;
      return runStatus && isActiveRunStatus(runStatus)
        ? POLL_ACTIVE_SESSION_MS
        : false;
    },
  });
}

/** Force a fresh fetch whenever the user navigates to a session. */
export function useRefetchSessionOnActivate(sessionId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    void queryClient.invalidateQueries({
      queryKey: sessionKeys.detail(sessionId),
    });
  }, [queryClient, sessionId]);
}

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error("Failed to create session");
      }

      return (await response.json()) as { session: Session };
    },
    onSuccess: ({ session }) => {
      queryClient.setQueryData<SessionDetailData>(sessionKeys.detail(session.id), {
        session,
        draft: null,
      });
      queryClient.setQueryData<SessionSummary[]>(sessionKeys.lists(), (current) =>
        current ? patchSessionSummary(current, session) : [sessionToSummary(session)],
      );
    },
  });
}

export function useInvalidateSessionDetail() {
  const queryClient = useQueryClient();

  return (sessionId: string) => {
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.detail(sessionId),
    });
  };
}

/** Keep sidebar summaries in sync when session detail refetches. */
export function useSyncSessionSummary(session: Session | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!session) {
      return;
    }

    queryClient.setQueryData<SessionSummary[]>(sessionKeys.lists(), (current) =>
      current ? patchSessionSummary(current, session) : current,
    );
  }, [
    queryClient,
    session,
    session?.id,
    session?.updatedAt,
    session?.runStatus,
    session?.title,
    session?.messages.length,
  ]);
}
