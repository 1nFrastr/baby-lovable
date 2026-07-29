"use client";

import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { AppServerStatus } from "@/lib/sandbox/preview-types";

type ConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "waiting"
  | "reconnecting"
  | "stale";

type LogSseEvent =
  | {
      type: "meta";
      generation: number;
      cmdId: string;
      sessionName: string;
    }
  | { type: "snapshot"; stdout: string; stderr: string }
  | { type: "chunk"; stream: "stdout" | "stderr"; text: string }
  | { type: "waiting"; reason: string }
  | { type: "stale"; reason: string }
  | { type: "error"; message: string };

interface DevServerLogsPanelProps {
  sessionId: string;
  generation: number;
  appServerStatus: AppServerStatus["status"];
  /** Drawer expanded and Preview tab active — opens SSE. */
  active: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 480;

function statusLabel(state: ConnectionState): string {
  switch (state) {
    case "live":
      return "live";
    case "waiting":
      return "waiting";
    case "reconnecting":
      return "reconnecting";
    case "stale":
      return "stale";
    case "connecting":
      return "connecting";
    case "idle":
    default:
      return "idle";
  }
}

function statusDotClass(state: ConnectionState): string {
  switch (state) {
    case "live":
      return "bg-emerald-500";
    case "waiting":
    case "reconnecting":
    case "connecting":
      return "bg-amber-400";
    case "stale":
      return "bg-red-500";
    default:
      return "bg-zinc-400";
  }
}

function canRetryStatus(status: AppServerStatus["status"]): boolean {
  return (
    status === "starting" || status === "ready" || status === "installing"
  );
}

export function DevServerLogsPanel({
  sessionId,
  generation,
  appServerStatus,
  active,
  expanded,
  onExpandedChange,
}: DevServerLogsPanelProps) {
  const [logs, setLogs] = useState("");
  const [streamState, setStreamState] = useState<
    Exclude<ConnectionState, "idle">
  >("connecting");
  const [follow, setFollow] = useState(true);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [statusDetail, setStatusDetail] = useState<string | null>(null);

  const scrollRef = useRef<HTMLPreElement | null>(null);
  const seenGenerationRef = useRef(generation);
  /** Retry eligibility — must not restart the SSE effect when status flickers. */
  const appServerStatusRef = useRef(appServerStatus);

  useEffect(() => {
    appServerStatusRef.current = appServerStatus;
  }, [appServerStatus]);

  const connection: ConnectionState =
    active && expanded ? streamState : "idle";

  useEffect(() => {
    if (!active || !expanded) {
      return;
    }

    let cancelled = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    /** Set before intentional close so EventSource onerror does not double-retry. */
    let ignoreNextError = false;
    let sawLive = false;

    if (seenGenerationRef.current !== generation) {
      seenGenerationRef.current = generation;
      queueMicrotask(() => {
        if (!cancelled) {
          setLogs("");
          setStatusDetail(null);
          setStreamState("reconnecting");
        }
      });
    }

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const closeSource = (opts?: { ignoreError?: boolean }) => {
      if (opts?.ignoreError) {
        ignoreNextError = true;
      }
      if (source) {
        source.close();
        source = null;
      }
    };

    const scheduleRetry = (reason: string) => {
      clearRetry();
      if (cancelled) {
        return;
      }

      if (!canRetryStatus(appServerStatusRef.current)) {
        setStreamState("stale");
        setStatusDetail(reason);
        return;
      }

      // Soft ceiling — keep trying while preview is warm; lengthen backoff.
      const delay = Math.min(15_000, 800 * 2 ** Math.min(retryAttempt, 4));
      retryAttempt += 1;
      setStreamState(sawLive ? "reconnecting" : "waiting");
      setStatusDetail(reason);
      retryTimer = setTimeout(() => {
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      closeSource({ ignoreError: true });
      clearRetry();
      ignoreNextError = false;
      setStreamState(sawLive ? "reconnecting" : "connecting");

      const url = `/api/sessions/${encodeURIComponent(sessionId)}/preview/logs`;
      const next = new EventSource(url);
      source = next;

      next.onmessage = (event) => {
        if (cancelled || source !== next) {
          return;
        }

        let payload: LogSseEvent;
        try {
          payload = JSON.parse(event.data) as LogSseEvent;
        } catch {
          return;
        }

        switch (payload.type) {
          case "meta":
            sawLive = true;
            setStreamState("live");
            setStatusDetail(null);
            retryAttempt = 0;
            break;
          case "snapshot":
            sawLive = true;
            setLogs(`${payload.stdout ?? ""}${payload.stderr ?? ""}`);
            setStreamState("live");
            setStatusDetail(null);
            retryAttempt = 0;
            break;
          case "chunk":
            sawLive = true;
            setLogs((prev) => prev + payload.text);
            setStreamState("live");
            break;
          case "waiting":
            closeSource({ ignoreError: true });
            scheduleRetry(payload.reason);
            break;
          case "stale":
            closeSource({ ignoreError: true });
            scheduleRetry(payload.reason);
            break;
          case "error":
            closeSource({ ignoreError: true });
            scheduleRetry(payload.message);
            break;
          default:
            break;
        }
      };

      next.onerror = () => {
        if (cancelled || source !== next) {
          return;
        }
        if (ignoreNextError) {
          ignoreNextError = false;
          return;
        }
        // Server closed the SSE (follow ended / proxy drop). Reattach.
        closeSource({ ignoreError: true });
        scheduleRetry(
          sawLive
            ? "Log stream disconnected — reconnecting"
            : "Connection failed — retrying",
        );
      };
    };

    connect();

    return () => {
      cancelled = true;
      clearRetry();
      closeSource({ ignoreError: true });
    };
    // Intentionally omit appServerStatus — status flicker must not tear down a live SSE.
  }, [active, expanded, sessionId, generation]);

  useEffect(() => {
    if (!follow || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs, follow, expanded]);

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = startY - moveEvent.clientY;
      setHeight(
        Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + delta)),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="flex shrink-0 flex-col border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      {expanded ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize console"
          onPointerDown={onResizePointerDown}
          className="h-1.5 cursor-ns-resize bg-transparent hover:bg-zinc-200 dark:hover:bg-zinc-800"
        />
      ) : null}

      <div className="flex h-8 shrink-0 items-center gap-2 px-2">
        <button
          type="button"
          onClick={() => onExpandedChange(!expanded)}
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-800"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
          )}
          Console
        </button>

        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${statusDotClass(connection)}`}
            aria-hidden
          />
          {statusLabel(connection)}
        </span>

        {statusDetail && active && expanded ? (
          <span
            className="min-w-0 flex-1 truncate text-[10px] text-zinc-400"
            title={statusDetail}
          >
            {statusDetail}
          </span>
        ) : (
          <span className="flex-1" />
        )}

        {expanded ? (
          <>
            <label className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                className="h-3 w-3 rounded border-zinc-300"
              />
              Follow
            </label>
            <button
              type="button"
              onClick={() => setLogs("")}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="Clear local view"
            >
              <Trash2 className="h-3 w-3" strokeWidth={2} />
              Clear
            </button>
          </>
        ) : null}
      </div>

      {expanded ? (
        <pre
          ref={scrollRef}
          style={{ height }}
          className="overflow-auto border-t border-zinc-200 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-200 dark:border-zinc-800"
        >
          {logs || (
            <span className="text-zinc-500">
              {connection === "waiting" || connection === "connecting"
                ? "Waiting for dev server logs…"
                : "No output yet."}
            </span>
          )}
        </pre>
      ) : null}
    </div>
  );
}
