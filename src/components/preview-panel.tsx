"use client";

import {
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  House,
  RefreshCw,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServerStatus } from "@/lib/sandbox/preview-types";
import {
  isFinishedRuntimeRunStatus,
  type SessionRuntimeProjection,
} from "@/lib/session/runtime-projection";
import { useInvalidateSessionRuntime } from "@/lib/session/runtime-query";

import { DevServerLogsPanel } from "./dev-server-logs-panel";
import { GithubSyncPanel } from "./github-sync-panel";
import { SourceControlStatusChip } from "./source-control-status";
import { VersionHistoryPanel } from "./version-history-panel";
import { WorkspaceFileExplorer } from "./workspace-file-explorer";

/** Survives React StrictMode remount — one warm POST per session per page load. */
const previewWarmRequested = new Set<string>();

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
  /** From AppShell useSessionRuntime — sole page-level runtime subscription. */
  runtimeProjection?: SessionRuntimeProjection | null;
  runtimeLoading?: boolean;
  runtimeError?: string | null;
  /** Live View from streamed testPreview tool output (agent path). */
  chatAppTest?: AppTestLatestStatus | null;
  /** True after Chat has reported an extract for this session (including none). */
  chatAppTestReady?: boolean;
}

/** Keep PiP visible briefly after the run ends so the final frame is usable. */
const PIP_HOLD_AFTER_DONE_MS = 10_000;
/** Retry once after ready so an early failed stylesheet request can recover. */
const READY_EMBED_RELOAD_DELAY_MS = 1_000;

type PreviewPanelTab = "preview" | "files" | "history";

/** Must match templates/nextjs-starter/src/instrumentation-client.ts */
const PREVIEW_BRIDGE_SOURCE = "baby-lovable-preview";

interface PreviewBridgeLocation {
  href: string;
  path: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface PreviewBridgeLocationMessage {
  source: typeof PREVIEW_BRIDGE_SOURCE;
  type: "location";
  href: string;
  path: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

function previewOrigin(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function withEmbedCacheBust(url: string, nonce: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("__baby_lovable_refresh", String(nonce));
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}__baby_lovable_refresh=${nonce}`;
  }
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
      return { status: "installing", url: preview.url };
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
  runtimeProjection = null,
  runtimeLoading = false,
  runtimeError = null,
  chatAppTest = null,
  chatAppTestReady = false,
}: PreviewPanelProps) {
  const invalidateRuntime = useInvalidateSessionRuntime();
  const projection = runtimeProjection;

  const preview: AppServerStatus = projection
    ? appServerFromProjection(projection.preview)
    : { status: "stopped" };
  const runtimeAppTest = projection
    ? appTestFromProjection(projection.appTest)
    : { status: "idle" as const };
  const previewGeneration = projection?.preview.generation ?? 0;
  const runStatus = projection?.run.status ?? "idle";
  const readyPreviewUrl =
    preview.status === "ready" ? preview.url : undefined;

  const [embedRemountNonce, setEmbedRemountNonce] = useState(0);
  const [loadedIframeKey, setLoadedIframeKey] = useState<string | null>(null);
  /** Soft prompt after an agent turn — user opts in to remount (avoids interrupting iframe interaction). */
  const [previewRefreshPending, setPreviewRefreshPending] = useState(false);
  const [previewReloadSpinning, setPreviewReloadSpinning] = useState(false);
  const previewReloadSpinTimerRef = useRef(0);
  const [previewAction, setPreviewAction] = useState<
    "warm" | "restart" | null
  >(null);
  const [previewActionError, setPreviewActionError] = useState<string | null>(
    null,
  );
  const [panelTab, setPanelTab] = useState<PreviewPanelTab>("preview");
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  /** Session id for which Files explorer stays mounted (avoids refetch on tab switch). */
  const [filesMountSessionId, setFilesMountSessionId] = useState<string | null>(
    null,
  );
  /** Bumped when an agent turn finishes — explorer re-lists from sandbox. */
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  /** Session id for which History panel stays mounted. */
  const [historyMountSessionId, setHistoryMountSessionId] = useState<
    string | null
  >(null);
  /** Bumped on turn end / sourceControl change — refetch version list. */
  const [versionsRefreshKey, setVersionsRefreshKey] = useState(0);
  const filesMounted = filesMountSessionId === sessionId;
  const historyMounted = historyMountSessionId === sessionId;
  const sourceControl = projection?.sourceControl ?? null;
  const prevAgentRunStatusRef = useRef<
    SessionRuntimeProjection["run"]["status"] | null
  >(null);
  const iframeLoadedRef = useRef(false);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);

  const [iframeLocation, setIframeLocation] =
    useState<PreviewBridgeLocation | null>(null);

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

  // Do not navigate while the proxy or Next is still warming. An early iframe
  // can retain failed CSS requests even after the document and HMR become ready.
  const previewEmbedUrl = readyPreviewUrl;
  const previewIframeKey = `${previewEmbedUrl ?? ""}::${previewGeneration}::${embedRemountNonce}`;
  const iframeLoaded =
    Boolean(previewEmbedUrl) && loadedIframeKey === previewIframeKey;
  iframeLoadedRef.current = iframeLoaded;

  // The root document can become reachable just before its CSS chunks do.
  // Retry one full navigation after ready; unlike HMR, this reloads failed
  // stylesheet links. Generation changes schedule the same safeguard on restart.
  useEffect(() => {
    if (!readyPreviewUrl) {
      return;
    }

    setPreviewRefreshPending(false);
    const timer = window.setTimeout(() => {
      setEmbedRemountNonce((nonce) => nonce + 1);
    }, READY_EMBED_RELOAD_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [readyPreviewUrl, previewGeneration]);

  // Prefetch the file tree as soon as the preview iframe is ready so the Files
  // tab opens without a first-click wait.
  useEffect(() => {
    if (!iframeLoaded) {
      return;
    }
    setFilesMountSessionId(sessionId);
  }, [iframeLoaded, sessionId]);

  useEffect(() => {
    setPreviewRefreshPending(false);
    setIframeLocation(null);
  }, [sessionId]);

  // Remount clears SPA history inside the iframe — reset chrome until bridge reports.
  useEffect(() => {
    setIframeLocation(null);
  }, [previewIframeKey]);

  // Cross-origin preview: location + history only via postMessage bridge.
  useEffect(() => {
    const expectedOrigin = previewOrigin(readyPreviewUrl);
    if (!expectedOrigin) {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) {
        return;
      }
      if (event.source !== previewIframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data as PreviewBridgeLocationMessage | null;
      if (
        !data ||
        typeof data !== "object" ||
        data.source !== PREVIEW_BRIDGE_SOURCE ||
        data.type !== "location" ||
        typeof data.path !== "string"
      ) {
        return;
      }

      setIframeLocation((prev) => ({
        href: typeof data.href === "string" ? data.href : data.path,
        path: data.path || "/",
        canGoBack:
          typeof data.canGoBack === "boolean"
            ? data.canGoBack
            : (prev?.canGoBack ?? false),
        canGoForward:
          typeof data.canGoForward === "boolean"
            ? data.canGoForward
            : (prev?.canGoForward ?? false),
      }));
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [readyPreviewUrl]);

  // After each agent turn: sync Files explorer, but do not remount the iframe
  // (that interrupts in-iframe interaction). Offer a soft refresh prompt instead.
  useEffect(() => {
    const previous = prevAgentRunStatusRef.current;
    prevAgentRunStatusRef.current = runStatus;

    const turnFinished =
      previous === "running" && isFinishedRuntimeRunStatus(runStatus);
    if (!turnFinished) {
      return;
    }

    queueMicrotask(() => {
      setFilesRefreshKey((key) => key + 1);
      setVersionsRefreshKey((key) => key + 1);
      if (readyPreviewUrl && iframeLoadedRef.current) {
        setPreviewRefreshPending(true);
      }
    });
  }, [runStatus, readyPreviewUrl]);

  // Checkpoint finishes after the chat unlocks — refresh History when save settles.
  useEffect(() => {
    if (!sourceControl) {
      return;
    }
    if (
      sourceControl.status === "synced" ||
      sourceControl.status === "error" ||
      sourceControl.status === "conflict"
    ) {
      queueMicrotask(() => {
        setVersionsRefreshKey((key) => key + 1);
      });
    }
  }, [sourceControl]);

  const applyPreviewRefresh = useCallback(() => {
    window.clearTimeout(previewReloadSpinTimerRef.current);
    setPreviewRefreshPending(false);
    setPreviewReloadSpinning(true);
    setEmbedRemountNonce((nonce) => nonce + 1);
  }, []);

  const navigatePreview = useCallback(
    (action: "back" | "forward" | "reload" | "home") => {
      const win = previewIframeRef.current?.contentWindow;
      const targetOrigin = previewOrigin(readyPreviewUrl);
      if (!win || !targetOrigin) {
        if (action === "reload" || action === "home") {
          applyPreviewRefresh();
        }
        return;
      }

      try {
        win.postMessage(
          {
            source: PREVIEW_BRIDGE_SOURCE,
            type: "navigate",
            action,
          },
          targetOrigin,
        );
        if (action === "reload") {
          setPreviewRefreshPending(false);
        }
      } catch {
        if (action === "reload" || action === "home") {
          applyPreviewRefresh();
        }
      }
    },
    [applyPreviewRefresh, readyPreviewUrl],
  );

  const handlePreviewReload = useCallback(() => {
    window.clearTimeout(previewReloadSpinTimerRef.current);
    setPreviewReloadSpinning(true);
    navigatePreview("reload");
    // Soft reload via postMessage usually keeps the same iframe document, so
    // onLoad may not fire — give a short spin so the click still feels real.
    previewReloadSpinTimerRef.current = window.setTimeout(() => {
      setPreviewReloadSpinning(false);
    }, 700);
  }, [navigatePreview]);

  useEffect(() => {
    if (iframeLoaded) {
      window.clearTimeout(previewReloadSpinTimerRef.current);
      setPreviewReloadSpinning(false);
    }
  }, [iframeLoaded]);

  useEffect(() => {
    return () => window.clearTimeout(previewReloadSpinTimerRef.current);
  }, []);

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

  const requestPreviewAction = useCallback(
    async (action: "warm" | "restart") => {
      setPreviewAction(action);
      setPreviewActionError(null);

      try {
        const response = await fetch(`/api/sessions/${sessionId}/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            data?.error ??
              `Preview ${action === "warm" ? "startup" : "restart"} failed`,
          );
        }
        invalidateRuntime(sessionId);
      } catch (error) {
        if (action === "warm") {
          previewWarmRequested.delete(sessionId);
        }
        setPreviewActionError(
          error instanceof Error ? error.message : "Preview request failed",
        );
      } finally {
        setPreviewAction(null);
      }
    },
    [
      invalidateRuntime,
      sessionId,
      setPreviewAction,
      setPreviewActionError,
    ],
  );

  // Enter / re-enter session once: kick startPreview.
  // Module Set survives React Strict Mode remount double-effects.
  useEffect(() => {
    const key = sessionId;
    if (previewWarmRequested.has(key)) {
      return;
    }
    previewWarmRequested.add(key);
    queueMicrotask(() => {
      void requestPreviewAction("warm");
    });
  }, [requestPreviewAction, sessionId]);

  const handleRestart = async () => {
    await requestPreviewAction("restart");
  };

  const handleRetry = () => {
    if (runtimeError && preview.status !== "error" && !previewActionError) {
      invalidateRuntime(sessionId);
      return;
    }

    void requestPreviewAction(
      preview.status === "error" ? "restart" : "warm",
    );
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
    Boolean(appTest.liveViewUrl) &&
    pipOpen &&
    (appTest.status === "running" || pipHoldActive) &&
    !pipDismissed;
  // Do not navigate while the proxy or Next is still warming. An early iframe
  // can retain failed CSS requests even after the document and HMR become ready.
  const previewIframeSrc = previewEmbedUrl
    ? withEmbedCacheBust(previewEmbedUrl, embedRemountNonce)
    : undefined;
  const displayError =
    previewActionError ??
    runtimeError ??
    (preview.status === "error" ? preview.error : null);
  const previewStatus =
    runtimeLoading && !projection
      ? {
          title: "正在连接预览环境",
          detail: "同步当前会话的运行状态…",
        }
      : preview.status === "installing"
        ? {
            title: "正在安装项目依赖",
            detail: "首次启动可能需要一点时间，完成后会自动打开。",
          }
        : preview.status === "starting"
          ? {
              title: "正在启动开发服务器",
              detail: "远程环境已准备好，正在等待应用响应。",
            }
          : preview.status === "ready" && !iframeLoaded
            ? {
                title: "正在载入应用",
                detail: "预览服务已就绪，正在渲染页面…",
              }
            : {
                title: "正在准备预览环境",
                detail: "正在唤醒远程工作区…",
              };
  const toolbarStatus =
    preview.status === "ready" && iframeLoaded
      ? (iframeLocation?.href ?? readyPreviewUrl)
      : displayError
        ? displayError
        : preview.status === "needs_install"
          ? "Project not ready"
          : previewStatus.title;

  const addressBarPath = iframeLocation?.path ?? "/";
  const addressBarTitle =
    iframeLocation?.href ?? readyPreviewUrl ?? previewEmbedUrl;
  const canNavigateBack =
    iframeLoaded && Boolean(iframeLocation?.canGoBack);
  const canNavigateForward =
    iframeLoaded && Boolean(iframeLocation?.canGoForward);

  const toolbarIconButtonClass =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-600 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-wait disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800";
  const showToolbarStatus =
    panelTab === "preview" &&
    Boolean(exportError || displayError || !(preview.status === "ready" && iframeLoaded));

  return (
    <section className="@container flex h-full min-w-0 flex-1 flex-col border-l border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-1.5 border-b border-zinc-200 px-2 py-1.5 @[320px]:gap-2 @[320px]:px-3 @[320px]:py-2 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <div
              className="flex shrink-0 items-center rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700"
              role="tablist"
              aria-label="Preview panel"
            >
              {(
                [
                  { id: "preview", label: "Preview" },
                  { id: "files", label: "Files" },
                  { id: "history", label: "History" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={panelTab === tab.id}
                  onClick={() => {
                    if (tab.id === "files") {
                      setFilesMountSessionId(sessionId);
                      setConsoleExpanded(false);
                    } else if (tab.id === "history") {
                      setHistoryMountSessionId(sessionId);
                      setConsoleExpanded(false);
                    }
                    setPanelTab(tab.id);
                  }}
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition @[360px]:px-2 @[360px]:py-1 @[360px]:text-xs ${
                    panelTab === tab.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <SourceControlStatusChip
              sourceControl={sourceControl}
              visible
            />
            {appTestBusy ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                title="App test running"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full bg-amber-500"
                  aria-hidden
                />
                <span className="hidden @[360px]:inline">Testing</span>
              </span>
            ) : null}
          </div>
          {showToolbarStatus ? (
            <p
              className={`mt-0.5 text-[11px] leading-snug dark:text-zinc-400 ${
                displayError || exportError
                  ? "whitespace-normal text-red-600 dark:text-red-400"
                  : "truncate text-zinc-500"
              }`}
            >
              {exportError ?? toolbarStatus}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {panelTab === "files" ? (
            <button
              type="button"
              onClick={() => setFilesRefreshKey((key) => key + 1)}
              className={toolbarIconButtonClass}
              title="同步文件列表"
              aria-label="同步文件列表"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          ) : panelTab === "history" ? (
            <button
              type="button"
              onClick={() => setVersionsRefreshKey((key) => key + 1)}
              className={toolbarIconButtonClass}
              title="刷新版本历史"
              aria-label="刷新版本历史"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  void handleExport();
                }}
                disabled={exporting}
                title={
                  exporting
                    ? "正在导出…"
                    : "导出源码 zip（已同步版本，不含 .git）"
                }
                aria-label={exporting ? "正在导出" : "导出源码"}
                className={toolbarIconButtonClass}
              >
                {exporting ? (
                  <RefreshCw
                    className="h-3.5 w-3.5 animate-spin"
                    strokeWidth={2}
                  />
                ) : (
                  <Download className="h-3.5 w-3.5" strokeWidth={2} />
                )}
              </button>
              <GithubSyncPanel
                sessionId={sessionId}
                visible
                linkedRepoName={sourceControl?.githubRepoName ?? null}
                sourceControlStatus={sourceControl?.status ?? null}
              />
              <button
                type="button"
                onClick={() => {
                  void handleRestart();
                }}
                disabled={previewAction !== null}
                title={
                  previewAction === "restart" ? "正在重启…" : "重启预览服务"
                }
                aria-label={
                  previewAction === "restart" ? "正在重启" : "重启预览"
                }
                className={toolbarIconButtonClass}
              >
                <RotateCcw
                  className={`h-3.5 w-3.5 ${
                    previewAction === "restart" ? "animate-spin" : ""
                  }`}
                  strokeWidth={2}
                />
              </button>
            </>
          )}
        </div>
      </div>

      {panelTab === "preview" && previewEmbedUrl ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => navigatePreview("back")}
              disabled={!canNavigateBack}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="后退"
              aria-label="后退"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => navigatePreview("forward")}
              disabled={!canNavigateForward}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="前进"
              aria-label="前进"
            >
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={handlePreviewReload}
              disabled={!iframeLoaded || previewReloadSpinning}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="刷新"
              aria-label="刷新"
              aria-busy={previewReloadSpinning || undefined}
            >
              <RotateCw
                className={`h-3.5 w-3.5 ${
                  previewReloadSpinning ? "animate-spin" : ""
                }`}
                strokeWidth={2}
              />
            </button>
            <button
              type="button"
              onClick={() => navigatePreview("home")}
              disabled={!iframeLoaded}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="回到预览首页"
              aria-label="回到预览首页"
            >
              <House className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
          <p
            className="min-w-0 flex-1 truncate rounded-md border border-zinc-200 bg-white px-2.5 py-1 font-mono text-[11px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
            title={addressBarTitle}
          >
            {addressBarPath}
          </p>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          className={`absolute inset-0 bg-white dark:bg-zinc-950 ${
            panelTab === "files" ? "" : "hidden"
          }`}
          aria-hidden={panelTab !== "files"}
        >
          {filesMounted ? (
            <WorkspaceFileExplorer
              key={sessionId}
              sessionId={sessionId}
              refreshKey={filesRefreshKey}
            />
          ) : null}
        </div>

        <div
          className={`absolute inset-0 bg-white dark:bg-zinc-950 ${
            panelTab === "history" ? "" : "hidden"
          }`}
          aria-hidden={panelTab !== "history"}
        >
          {historyMounted ? (
            <VersionHistoryPanel
              key={sessionId}
              sessionId={sessionId}
              refreshKey={versionsRefreshKey}
            />
          ) : null}
        </div>

        <div
          className={`absolute inset-0 bg-zinc-100 dark:bg-zinc-950 ${
            panelTab === "preview" ? "" : "hidden"
          }`}
          aria-hidden={panelTab !== "preview"}
        >
          {previewEmbedUrl ? (
            <>
              <div
                className={`absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 px-6 text-center transition-opacity duration-300 ${
                  iframeLoaded
                    ? "pointer-events-none opacity-0"
                    : "opacity-100"
                }`}
                role="status"
                aria-live="polite"
                aria-hidden={iframeLoaded}
              >
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {previewStatus.title}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {previewStatus.detail}
                  </p>
                </div>
              </div>
              {previewRefreshPending && iframeLoaded ? (
                <div className="absolute top-3 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-200 bg-white/95 px-1.5 py-1 shadow-sm backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95">
                  <button
                    type="button"
                    onClick={applyPreviewRefresh}
                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-zinc-800 transition hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <RefreshCw className="h-3 w-3" strokeWidth={2} />
                    预览有更新 · 刷新
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewRefreshPending(false)}
                    className="rounded-full px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    aria-label="忽略预览刷新提示"
                    title="忽略"
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                </div>
              ) : null}
              <iframe
                ref={previewIframeRef}
                key={previewIframeKey}
                src={previewIframeSrc}
                title="App preview"
                onLoad={() => setLoadedIframeKey(previewIframeKey)}
                className={`h-full w-full border-0 bg-white transition-opacity duration-300 ${
                  iframeLoaded ? "opacity-100" : "opacity-0"
                }`}
                allow="accelerometer; camera; microphone; clipboard-write"
              />
            </>
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-zinc-500 dark:text-zinc-400"
              role={displayError ? "alert" : "status"}
              aria-live="polite"
            >
              {preview.status === "needs_install" ? (
                <>
                  <p className="font-medium text-zinc-700 dark:text-zinc-200">
                    项目尚未就绪
                  </p>
                  <p>缺少 package.json，无法启动预览。</p>
                </>
              ) : displayError ? (
                <>
                  <p className="font-medium text-red-600 dark:text-red-400">
                    暂时无法打开预览
                  </p>
                  <p className="max-w-md whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
                    {displayError}
                  </p>
                  {displayError.includes("联系作者") ? (
                    <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
                      这是平台侧 Daytona 资源限制，需要作者在控制台清理闲置
                      Sandbox 或升级配额后，再点 Restart 重试。
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={handleRetry}
                    disabled={previewAction !== null || runtimeLoading}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-wait disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <RotateCcw
                      className={`h-3.5 w-3.5 ${
                        previewAction ? "animate-spin" : ""
                      }`}
                      strokeWidth={2}
                    />
                    {previewAction ? "正在重试…" : "重试"}
                  </button>
                </>
              ) : (
                <>
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
                  <div className="space-y-1">
                    <p className="font-medium text-zinc-700 dark:text-zinc-200">
                      {previewStatus.title}
                    </p>
                    <p className="text-xs">{previewStatus.detail}</p>
                  </div>
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
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-zinc-100 dark:text-blue-400 dark:hover:bg-zinc-800"
                  >
                    <ExternalLink className="h-3 w-3" strokeWidth={2} />
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
                    className="inline-flex items-center rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    aria-label="Close Live View"
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
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

          {appTest.status === "running" &&
          appTest.liveViewUrl &&
          pipDismissed ? (
            <a
              href={appTest.liveViewUrl}
              target="_blank"
              rel="noreferrer"
              className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
              Open Live View
            </a>
          ) : null}
        </div>
      </div>

      {panelTab === "preview" ? (
        <DevServerLogsPanel
          sessionId={sessionId}
          generation={previewGeneration}
          appServerStatus={preview.status}
          active={consoleExpanded}
          expanded={consoleExpanded}
          onExpandedChange={setConsoleExpanded}
        />
      ) : null}
    </section>
  );
}
