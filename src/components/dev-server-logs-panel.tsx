"use client";

import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { AppServerStatus } from "@/lib/sandbox/preview-types";
import { parseAnsiText } from "./dev-server-log-ansi";
import {
  appendDevLogChunk,
  applyDevLogSnapshot,
  clearDevLogBuffer,
  emptyDevLogBuffer,
  setDevLogIdentity,
} from "./dev-server-log-buffer";

type ConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "waiting"
  | "reconnecting"
  | "offline"
  | "ended"
  | "stale";

type LogSseEvent =
  | {
      type: "meta";
      generation: number;
      cmdId: string;
      sessionName: string;
    }
  | {
      type: "snapshot";
      stdout: string;
      stderr: string;
      truncated?: boolean;
    }
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
      return "Live";
    case "waiting":
      return "Waiting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "ended":
      return "Process ended";
    case "stale":
      return "Unavailable";
    case "connecting":
      return "Connecting";
    case "idle":
    default:
      return "Disconnected";
  }
}

function statusDotClass(state: ConnectionState): string {
  switch (state) {
    case "live":
      return "bg-emerald-500";
    case "waiting":
    case "reconnecting":
    case "connecting":
    case "offline":
      return "bg-amber-400";
    case "ended":
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

function readableReason(reason: string): string {
  if (/Dev session not started/i.test(reason)) {
    return "Dev server has not started";
  }
  if (/Sandbox unavailable/i.test(reason)) {
    return "Sandbox unavailable; waiting for preview to start";
  }
  if (/command id not ready/i.test(reason)) {
    return "Log process not ready yet";
  }
  const exit = reason.match(/exited with code\s+(-?\d+)/i);
  if (exit) {
    return `Dev process ended (exit code ${exit[1]})`;
  }
  if (/Failed to read command logs/i.test(reason)) {
    return "Unable to read logs; reconnecting";
  }
  return reason;
}

export function DevServerLogsPanel({
  sessionId,
  generation,
  appServerStatus,
  active,
  expanded,
  onExpandedChange,
}: DevServerLogsPanelProps) {
  const [buffer, setBuffer] = useState(emptyDevLogBuffer);
  const [streamState, setStreamState] = useState<
    Exclude<ConnectionState, "idle">
  >("connecting");
  const [follow, setFollow] = useState(true);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const scrollRef = useRef<HTMLPreElement | null>(null);
  const seenGenerationRef = useRef(generation);
  const retryExhaustedRef = useRef(false);
  /** Retry eligibility — must not restart the SSE effect when status flickers. */
  const appServerStatusRef = useRef(appServerStatus);

  useEffect(() => {
    appServerStatusRef.current = appServerStatus;
  }, [appServerStatus]);

  const connection: ConnectionState =
    active && expanded ? streamState : "idle";
  const renderedLogs = useMemo(() => parseAnsiText(buffer.text), [buffer.text]);

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
    retryExhaustedRef.current = false;

    if (seenGenerationRef.current !== generation) {
      seenGenerationRef.current = generation;
      queueMicrotask(() => {
        if (!cancelled) {
          setBuffer(emptyDevLogBuffer());
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

    const scheduleRetry = (
      reason: string,
      visibleState?: "waiting" | "reconnecting" | "ended",
    ) => {
      const detail = readableReason(reason);
      clearRetry();
      if (cancelled) {
        return;
      }

      if (!navigator.onLine) {
        setStreamState("offline");
        setStatusDetail("Network offline; waiting to reconnect");
        return;
      }

      if (!canRetryStatus(appServerStatusRef.current)) {
        setStreamState("stale");
        setStatusDetail(detail);
        return;
      }
      if (retryAttempt >= 8) {
        retryExhaustedRef.current = true;
        setStreamState("stale");
        setStatusDetail("Unable to connect to logs for a while; collapse and reopen to retry");
        return;
      }

      // Soft ceiling — keep trying while preview is warm; lengthen backoff.
      const base = Math.min(15_000, 800 * 2 ** Math.min(retryAttempt, 4));
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      retryAttempt += 1;
      setStreamState(
        visibleState ?? (sawLive ? "reconnecting" : "waiting"),
      );
      setStatusDetail(detail);
      retryTimer = setTimeout(() => {
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) {
        return;
      }
      if (!navigator.onLine) {
        setStreamState("offline");
        setStatusDetail("Network offline; waiting to reconnect");
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
            retryExhaustedRef.current = false;
            seenGenerationRef.current = payload.generation;
            setBuffer((current) =>
              setDevLogIdentity(current, {
                generation: payload.generation,
                cmdId: payload.cmdId,
                sessionName: payload.sessionName,
              }),
            );
            setStreamState("live");
            setStatusDetail(null);
            retryAttempt = 0;
            break;
          case "snapshot":
            sawLive = true;
            setBuffer((current) =>
              applyDevLogSnapshot(
                current,
                payload.stdout ?? "",
                payload.stderr ?? "",
                payload.truncated,
              ),
            );
            setStreamState("live");
            setStatusDetail(null);
            retryAttempt = 0;
            break;
          case "chunk":
            sawLive = true;
            setBuffer((current) =>
              appendDevLogChunk(current, payload.stream, payload.text),
            );
            setStreamState("live");
            break;
          case "waiting":
            closeSource({ ignoreError: true });
            scheduleRetry(payload.reason);
            break;
          case "stale":
            closeSource({ ignoreError: true });
            scheduleRetry(
              payload.reason,
              /exited|ended|not found/i.test(payload.reason)
                ? "ended"
                : undefined,
            );
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
            ? "Log connection interrupted; reconnecting"
            : "Connection failed; retrying",
        );
      };
    };

    const onOffline = () => {
      closeSource({ ignoreError: true });
      clearRetry();
      setStreamState("offline");
      setStatusDetail("Network offline; waiting to reconnect");
    };
    const onOnline = () => {
      if (cancelled) {
        return;
      }
      retryAttempt = 0;
      retryExhaustedRef.current = false;
      setStatusDetail("Network restored; reconnecting");
      connect();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    connect();

    return () => {
      cancelled = true;
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      clearRetry();
      closeSource({ ignoreError: true });
    };
    // Intentionally omit appServerStatus — status flicker must not tear down a live SSE.
  }, [active, expanded, sessionId, generation, retryKey]);

  useEffect(() => {
    if (
      active &&
      expanded &&
      navigator.onLine &&
      !retryExhaustedRef.current &&
      canRetryStatus(appServerStatus) &&
      (streamState === "stale" ||
        streamState === "ended" ||
        streamState === "offline")
    ) {
      setRetryKey((value) => value + 1);
    }
  }, [active, expanded, appServerStatus, streamState]);

  useEffect(() => {
    if (!follow || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [buffer.text, follow, expanded]);

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
              Auto-scroll
            </label>
            <button
              type="button"
              onClick={() => setBuffer((current) => clearDevLogBuffer(current))}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="Clear local display for this process"
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
          {buffer.text ? (
            renderedLogs.map((segment, index) => (
              <span key={index} style={segment.style}>
                {segment.text}
              </span>
            ))
          ) : (
            <span className="text-zinc-500">
              {connection === "waiting" || connection === "connecting"
                ? "Waiting for dev server logs…"
                : connection === "offline"
                  ? "Network offline; streaming will resume when connected."
                  : connection === "ended"
                    ? "Dev process ended; waiting for the server to come back."
                    : "No output yet."}
            </span>
          )}
        </pre>
      ) : null}
    </div>
  );
}
