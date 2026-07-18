"use client";

import { useEffect, useRef, useState } from "react";

import type { AppServerStatus, SandboxStatus } from "@/lib/sandbox/preview-types";
import type { SandboxMode } from "@/lib/sandbox/types";
import type { SessionRuntimeProjection } from "@/lib/session/runtime-projection";
import { useInvalidateSessionRuntime } from "@/lib/session/runtime-query";

/** Mirrors AppTestLatestStatus — kept local so the client bundle does not pull Node fs. */
interface AppTestLatestStatus {
  status: "idle" | "running" | "done" | "error";
  runId?: string;
  liveViewUrl?: string;
  ok?: boolean;
  summary?: string;
  artifactDir?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  usedScriptedActions?: boolean;
}

interface PreviewPanelProps {
  sessionId: string;
  sandboxMode?: SandboxMode;
  /** From AppShell useSessionRuntime — sole page-level runtime subscription. */
  runtimeProjection?: SessionRuntimeProjection | null;
  /** Live View from streamed testPreview tool output (agent path). */
  chatAppTest?: AppTestLatestStatus | null;
  /** True after Chat has reported an extract for this session (including none). */
  chatAppTestReady?: boolean;
}

/** Keep PiP visible briefly after the run ends so the final frame is usable. */
const PIP_HOLD_AFTER_DONE_MS = 10_000;

function mergeChatAndPolledAppTest(
  polled: AppTestLatestStatus,
  chat: AppTestLatestStatus | null,
): AppTestLatestStatus {
  if (!chat?.liveViewUrl && chat?.status !== "running") {
    return polled;
  }

  const liveViewUrl = chat.liveViewUrl ?? polled.liveViewUrl;
  // Prefer poll for mid-run Live View; chat only has the URL after the
  // durable step returns. Don't let a late "done" chat result + stale
  // "running" poll keep the Testing badge stuck forever — once chat is
  // terminal and poll has no newer running signal with a URL, settle.
  const chatTerminal = chat.status === "done" || chat.status === "error";
  const pollRunning = polled.status === "running";
  const status: AppTestLatestStatus["status"] =
    chat.status === "running" || (pollRunning && !chatTerminal)
      ? "running"
      : chatTerminal
        ? chat.status!
        : (polled.status ?? chat.status ?? "idle");

  return {
    ...polled,
    ...chat,
    liveViewUrl,
    status,
    runId: chat.runId ?? polled.runId,
    summary: chat.summary ?? polled.summary,
    ok: chat.ok ?? polled.ok,
    error: chat.error ?? polled.error,
  };
}

function appServerFromProjection(
  preview: SessionRuntimeProjection["preview"],
): AppServerStatus {
  switch (preview.appServerStatus) {
    case "ready":
      return {
        status: "ready",
        url: preview.url ?? "",
        port: 0,
      };
    case "starting":
      return {
        status: "starting",
        port: 0,
        url: preview.url,
      };
    case "error":
      return {
        status: "error",
        error: preview.error ?? "Dev server failed",
      };
    case "installing":
      return { status: "installing" };
    case "needs_install":
      return { status: "needs_install" };
    case "stopped":
    default:
      return { status: "stopped" };
  }
}

function appTestFromProjection(
  appTest: SessionRuntimeProjection["appTest"],
): AppTestLatestStatus {
  return {
    status: appTest.status,
    runId: appTest.runId,
    liveViewUrl: appTest.liveViewUrl,
    ok: appTest.ok,
    summary: appTest.summary,
  };
}

export function PreviewPanel({
  sessionId,
  sandboxMode = "local",
  runtimeProjection = null,
  chatAppTest = null,
  chatAppTestReady = false,
}: PreviewPanelProps) {
  const invalidateRuntime = useInvalidateSessionRuntime();
  const projection = runtimeProjection;

  const preview: AppServerStatus = projection
    ? appServerFromProjection(projection.preview)
    : { status: "stopped" };
  const sandboxStatus: SandboxStatus =
    projection?.preview.sandbox ?? "missing";
  const runtimeAppTest = projection
    ? appTestFromProjection(projection.appTest)
    : { status: "idle" as const };
  const previewGeneration = projection?.preview.generation ?? 0;

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  /** PiP only opens for a live chat-driven run — never on hydrate/refresh. */
  const [pipOpen, setPipOpen] = useState(false);
  const [pipDismissed, setPipDismissed] = useState(false);
  const [pipHoldActive, setPipHoldActive] = useState(false);
  const pipHydratedRef = useRef(false);
  const prevChatStatusRef = useRef<AppTestLatestStatus["status"] | null>(null);
  const pendingPipOpenRef = useRef(false);
  const lastPipRunIdRef = useRef<string | undefined>(undefined);
  const pipHoldTimerRef = useRef(0);

  const appTest = mergeChatAndPolledAppTest(runtimeAppTest, chatAppTest);

  // Open Live View only when the chat stream transitions into a running
  // testPreview after Chat has hydrated history. Refresh / session switch
  // must not pop the PiP for past or in-flight rehydrated runs.
  useEffect(() => {
    if (!chatAppTestReady) {
      return;
    }

    const chatStatus = chatAppTest?.status ?? "idle";
    const prevChatStatus = prevChatStatusRef.current;
    const liveViewUrl = appTest.liveViewUrl ?? chatAppTest?.liveViewUrl;

    if (!pipHydratedRef.current) {
      pipHydratedRef.current = true;
      prevChatStatusRef.current = chatStatus;
      lastPipRunIdRef.current = appTest.runId ?? chatAppTest?.runId;
      return;
    }

    const runId = appTest.runId ?? chatAppTest?.runId;
    if (runId && runId !== lastPipRunIdRef.current) {
      lastPipRunIdRef.current = runId;
      queueMicrotask(() => setPipDismissed(false));
    }

    if (chatStatus === "running" && prevChatStatus !== "running") {
      pendingPipOpenRef.current = true;
      queueMicrotask(() => setPipDismissed(false));
    }

    if (
      pendingPipOpenRef.current &&
      chatStatus === "running" &&
      liveViewUrl &&
      !pipDismissed
    ) {
      pendingPipOpenRef.current = false;
      queueMicrotask(() => setPipOpen(true));
    }

    if (
      (chatStatus === "done" || chatStatus === "error") &&
      prevChatStatus === "running" &&
      pipOpen &&
      !pipDismissed &&
      liveViewUrl
    ) {
      window.clearTimeout(pipHoldTimerRef.current);
      queueMicrotask(() => setPipHoldActive(true));
      pipHoldTimerRef.current = window.setTimeout(() => {
        setPipHoldActive(false);
        setPipOpen(false);
      }, PIP_HOLD_AFTER_DONE_MS);
    }

    if (chatStatus === "idle") {
      pendingPipOpenRef.current = false;
      window.clearTimeout(pipHoldTimerRef.current);
      queueMicrotask(() => {
        setPipHoldActive(false);
        setPipOpen(false);
      });
    }

    prevChatStatusRef.current = chatStatus;
  }, [
    chatAppTestReady,
    chatAppTest,
    appTest.liveViewUrl,
    appTest.runId,
    pipOpen,
    pipDismissed,
  ]);

  useEffect(() => {
    return () => {
      window.clearTimeout(pipHoldTimerRef.current);
    };
  }, []);

  // Enter / re-enter session once: kick startPreview. invalidateRuntime must stay
  // referentially stable (useCallback) or this effect loops with POST /preview.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await fetch(`/api/sessions/${sessionId}/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "warm" }),
        });
        if (!cancelled) {
          invalidateRuntime(sessionId);
        }
      } catch {
        // runtime subscription / invalidate will reflect stopped / error
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, invalidateRuntime]);

  const handleRestart = async () => {
    try {
      await fetch(`/api/sessions/${sessionId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      invalidateRuntime(sessionId);
    } catch {
      // runtime subscription will pick up status
    }
  };

  const handleExport = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/export`);
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? `Export failed (${response.status})`);
      }

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `${sessionId}-workspace.zip`;

      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Export failed",
      );
    } finally {
      setExporting(false);
    }
  };

  const appTestBusy = appTest.status === "running";
  const showPip =
    sandboxMode === "daytona" &&
    Boolean(appTest.liveViewUrl) &&
    pipOpen &&
    (appTest.status === "running" || pipHoldActive) &&
    !pipDismissed;
  // Keep iframe mounted across restart — public preview URL is stable; Next down is 502.
  const previewEmbedUrl =
    preview.status === "ready"
      ? preview.url
      : preview.status === "starting"
        ? preview.url
        : undefined;
  // Remount only when URL or restart generation changes — not on checkPreview.
  const previewIframeKey = `${previewEmbedUrl ?? ""}::${previewGeneration}`;

  return (
    <section className="flex min-w-0 flex-1 flex-col border-l border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Preview
            </p>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                sandboxMode === "daytona"
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {sandboxMode}
            </span>
            {appTestBusy ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Testing
              </span>
            ) : null}
          </div>
          <p
            className={`text-xs dark:text-zinc-400 ${
              preview.status === "error" || exportError
                ? "whitespace-normal text-red-600 dark:text-red-400"
                : "truncate text-zinc-500"
            }`}
          >
            {preview.status === "ready"
              ? preview.url
              : exportError
                ? exportError
                : preview.status === "starting"
                  ? sandboxMode === "daytona"
                    ? "Starting Daytona preview…"
                    : "Starting dev server…"
                  : preview.status === "installing"
                    ? "Installing dependencies…"
                    : preview.status === "needs_install"
                      ? "Project not ready"
                      : preview.status === "error"
                        ? preview.error
                        : sandboxStatus === "stopped"
                          ? "Sandbox stopped — waiting for agent to warm preview…"
                          : "Waiting for agent to start preview…"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void handleExport();
            }}
            disabled={exporting || sandboxMode === "local"}
            title={
              sandboxMode === "local"
                ? "Local export is not implemented yet"
                : "Download workspace as git archive zip"
            }
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            {exporting ? "Exporting…" : "Export"}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleRestart();
            }}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Restart
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-zinc-100 dark:bg-zinc-950">
        {previewEmbedUrl ? (
          <iframe
            key={previewIframeKey}
            src={previewEmbedUrl}
            title="App preview"
            className="h-full w-full border-0 bg-white"
            allow="accelerometer; camera; microphone; clipboard-write"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {preview.status === "installing" ? (
              <>
                <span className="inline-flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.1s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.2s]" />
                </span>
                <p>
                  {sandboxMode === "daytona"
                    ? "正在远程沙箱安装依赖（pnpm）…"
                    : "正在安装依赖（pnpm）…"}
                </p>
              </>
            ) : preview.status === "needs_install" ? (
              <>
                <p className="font-medium text-zinc-700 dark:text-zinc-200">
                  项目尚未就绪
                </p>
                <p>缺少 package.json，无法启动预览。</p>
              </>
            ) : preview.status === "error" ? (
              <>
                <p className="font-medium text-red-600 dark:text-red-400">
                  预览启动失败
                </p>
                <p className="max-w-md whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
                  {preview.error}
                </p>
                {preview.error?.includes("联系作者") ? (
                  <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
                    这是平台侧 Daytona 资源限制，需要作者在控制台清理闲置
                    Sandbox 或升级配额后，再点 Restart 重试。
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <span className="inline-flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.1s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.2s]" />
                </span>
                <p>
                  {sandboxMode === "daytona"
                    ? "正在启动 Daytona 远程预览…"
                    : "正在启动 dev server…"}
                </p>
              </>
            )}
          </div>
        )}

        {showPip && appTest.liveViewUrl ? (
          <div className="absolute bottom-3 right-3 z-10 flex w-[320px] flex-col overflow-hidden rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-700">
              <p className="truncate text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                App Test Live View
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={appTest.liveViewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-zinc-100 dark:text-blue-400 dark:hover:bg-zinc-800"
                >
                  Open
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setPipDismissed(true);
                    setPipOpen(false);
                    window.clearTimeout(pipHoldTimerRef.current);
                    setPipHoldActive(false);
                    pendingPipOpenRef.current = false;
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  aria-label="Close Live View"
                >
                  ✕
                </button>
              </div>
            </div>
            <iframe
              key={appTest.liveViewUrl}
              src={appTest.liveViewUrl}
              title="App test Live View"
              className="h-[200px] w-full border-0 bg-zinc-950"
              allow="clipboard-read; clipboard-write"
            />
          </div>
        ) : null}

        {sandboxMode === "daytona" &&
        appTest.status === "running" &&
        appTest.liveViewUrl &&
        pipDismissed ? (
          <a
            href={appTest.liveViewUrl}
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-3 right-3 z-10 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          >
            Open Live View
          </a>
        ) : null}
      </div>
    </section>
  );
}
