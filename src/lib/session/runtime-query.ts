"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isLocalFileStorageMode } from "@/lib/supabase/config";

import type {
  RuntimeTransport,
  SessionRuntimeProjection,
} from "./runtime-projection";

export const runtimeKeys = {
  detail: (sessionId: string) => ["session-runtime", sessionId] as const,
};

export interface SessionRuntimeData {
  projection: SessionRuntimeProjection;
  transport: RuntimeTransport;
}

async function fetchRuntime(sessionId: string): Promise<SessionRuntimeData> {
  const response = await fetch(`/api/sessions/${sessionId}/runtime`);
  if (response.status === 404) {
    throw new Error("Session not found");
  }
  if (!response.ok) {
    throw new Error("Failed to load session runtime");
  }
  return (await response.json()) as SessionRuntimeData;
}

function applyProjectionIfNewer(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
  next: SessionRuntimeProjection,
): void {
  queryClient.setQueryData<SessionRuntimeData>(
    runtimeKeys.detail(sessionId),
    (current) => {
      if (!current || next.version > current.projection.version) {
        return {
          projection: next,
          transport: current?.transport ?? (isLocalFileStorageMode() ? "sse" : "realtime"),
        };
      }
      return current;
    },
  );
}

/** React Query cache for runtime projection (no transport subscription). */
export function useSessionRuntimeQuery(sessionId: string | null) {
  return useQuery({
    queryKey: runtimeKeys.detail(sessionId ?? ""),
    queryFn: () => fetchRuntime(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

/**
 * Single page-level subscription for session runtime (run / preview / appTest).
 * Call once per session view (e.g. AppShell). Transport follows persist backend:
 * file store → SSE; Supabase → Realtime.
 */
export function useSessionRuntime(sessionId: string | null) {
  const queryClient = useQueryClient();
  const query = useSessionRuntimeQuery(sessionId);

  const transport =
    query.data?.transport ??
    (isLocalFileStorageMode() ? "sse" : ("realtime" as RuntimeTransport));

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const invalidate = () => {
      void queryClient.invalidateQueries({
        queryKey: runtimeKeys.detail(sessionId),
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        invalidate();
      }
    };

    const onOnline = () => {
      invalidate();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);

    if (transport === "sse") {
      const source = new EventSource(`/api/sessions/${sessionId}/events`);
      source.onmessage = (event) => {
        if (cancelled) {
          return;
        }
        try {
          const projection = JSON.parse(
            event.data,
          ) as SessionRuntimeProjection;
          applyProjectionIfNewer(queryClient, sessionId, projection);
        } catch {
          // ignore malformed
        }
      };
      source.onerror = () => {
        // Browser will retry EventSource; also refresh snapshot.
        invalidate();
      };
      cleanup = () => {
        source.close();
      };
    } else {
      const supabase = createSupabaseBrowserClient();
      const channel = supabase
        .channel(`runtime:${sessionId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "session_runtime_projection",
            filter: `session_id=eq.${sessionId}`,
          },
          (payload) => {
            if (cancelled) {
              return;
            }
            const row = payload.new as {
              projection?: SessionRuntimeProjection;
            } | null;
            if (row?.projection) {
              applyProjectionIfNewer(queryClient, sessionId, row.projection);
            } else {
              invalidate();
            }
          },
        )
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            invalidate();
          }
        });

      cleanup = () => {
        void supabase.removeChannel(channel);
      };
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      cleanup?.();
    };
  }, [queryClient, sessionId, transport]);

  return query;
}

/** Invalidate runtime cache after user commands (Restart / Run Test). */
export function useInvalidateSessionRuntime() {
  const queryClient = useQueryClient();

  // Must be referentially stable — PreviewPanel warm effect depends on this.
  // A fresh function each render re-fires POST /preview + GET /runtime in a loop.
  return useCallback(
    (sessionId: string) => {
      void queryClient.invalidateQueries({
        queryKey: runtimeKeys.detail(sessionId),
      });
    },
    [queryClient],
  );
}
