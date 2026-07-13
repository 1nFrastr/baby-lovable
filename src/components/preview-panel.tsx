"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PreviewStatus } from "@/lib/sandbox/dev-server";
import type { SandboxMode } from "@/lib/sandbox/types";

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
  /** Live View from streamed testPreview tool output (agent path). */
  chatAppTest?: AppTestLatestStatus | null;
}

const POLL_MS_READY = 15_000;
const POLL_MS_ACTIVE = 2_000;
const APP_TEST_POLL_MS = 1_500;
const APP_TEST_POLL_MS_RUNNING = 800;
/** Keep PiP visible briefly after the run ends so the final frame is usable. */
const PIP_HOLD_AFTER_DONE_MS = 10_000;

function pollDelay(status: PreviewStatus["status"]): number {
  return status === "ready" ? POLL_MS_READY : POLL_MS_ACTIVE;
}

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

export function PreviewPanel({
  sessionId,
  sandboxMode = "local",
  chatAppTest = null,
}: PreviewPanelProps) {
  const [preview, setPreview] = useState<PreviewStatus>({ status: "stopped" });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [polledAppTest, setPolledAppTest] = useState<AppTestLatestStatus>({
    status: "idle",
  });
  const [pipDismissed, setPipDismissed] = useState(false);
  const [pipHoldUntil, setPipHoldUntil] = useState(0);
  const [pipHoldTick, setPipHoldTick] = useState(0);
  const previewRef = useRef(preview);
  const appTestPollBusyRef = useRef(false);

  const appTest = mergeChatAndPolledAppTest(polledAppTest, chatAppTest);
  appTestPollBusyRef.current =
    appTest.status === "running" || chatAppTest?.status === "running";

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    setPipDismissed(false);
  }, [appTest.runId, appTest.liveViewUrl]);

  useEffect(() => {
    if (
      (appTest.status === "done" || appTest.status === "error") &&
      appTest.liveViewUrl
    ) {
      setPipHoldUntil(Date.now() + PIP_HOLD_AFTER_DONE_MS);
    }
  }, [appTest.status, appTest.liveViewUrl, appTest.runId]);

  useEffect(() => {
    if (pipHoldUntil <= Date.now()) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setPipHoldTick((n) => n + 1);
    }, pipHoldUntil - Date.now() + 50);
    return () => window.clearTimeout(timeoutId);
  }, [pipHoldUntil, pipHoldTick]);

  const loadPreview = useCallback(async (): Promise<PreviewStatus | null> => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/preview`);
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { preview: PreviewStatus };
      setPreview(data.preview);
      return data.preview;
    } catch {
      return null;
    }
  }, [sessionId]);

  const loadAppTest = useCallback(async () => {
    if (sandboxMode !== "daytona") {
      return;
    }
    try {
      const response = await fetch(`/api/sessions/${sessionId}/app-test`);
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as AppTestLatestStatus & {
        error?: string;
      };
      setPolledAppTest({
        status: data.status ?? "idle",
        runId: data.runId,
        liveViewUrl: data.liveViewUrl,
        ok: data.ok,
        summary: data.summary,
        artifactDir: data.artifactDir,
        startedAt: data.startedAt,
        finishedAt: data.finishedAt,
        error: data.error,
        usedScriptedActions: data.usedScriptedActions,
      });
    } catch {
      // next poll
    }
  }, [sandboxMode, sessionId]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId = 0;

    const schedule = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (cancelled) {
        return;
      }

      const next = await loadPreview();
      if (cancelled) {
        return;
      }

      const status = next?.status ?? previewRef.current.status;
      schedule(pollDelay(status));
    };

    void poll();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [loadPreview, sessionId]);

  useEffect(() => {
    if (sandboxMode !== "daytona") {
      return;
    }

    let cancelled = false;
    let timeoutId = 0;

    const tick = async () => {
      if (cancelled) {
        return;
      }
      await loadAppTest();
      if (cancelled) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        void tick();
      }, appTestPollBusyRef.current
        ? APP_TEST_POLL_MS_RUNNING
        : APP_TEST_POLL_MS);
    };

    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [loadAppTest, sandboxMode, sessionId]);

  const handleRestart = async () => {
    setPreview({ status: "starting", port: 0 });
    try {
      await fetch(`/api/sessions/${sessionId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      await loadPreview();
    } catch {
      // next poll will pick up status
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
  const pipHoldActive = pipHoldUntil > Date.now();
  const showPip =
    sandboxMode === "daytona" &&
    Boolean(appTest.liveViewUrl) &&
    (appTest.status === "running" || pipHoldActive) &&
    !pipDismissed;
  const lastSummary =
    appTest.status === "done" || appTest.status === "error"
      ? appTest.summary ?? appTest.error
      : null;

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
              preview.status === "error"
                ? "whitespace-normal text-red-600 dark:text-red-400"
                : "truncate text-zinc-500"
            }`}
          >
            {exportError
              ? exportError
              : lastSummary
                ? `App test: ${lastSummary}`
                : preview.status === "ready"
                  ? preview.url
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
                          : "Preview not started"}
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
        {preview.status === "ready" ? (
          <iframe
            key={preview.url}
            src={preview.url}
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
                  onClick={() => setPipDismissed(true)}
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
