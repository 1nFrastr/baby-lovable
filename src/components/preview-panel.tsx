"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PreviewStatus } from "@/lib/sandbox/dev-server";
import type { SandboxMode } from "@/lib/sandbox/types";

interface PreviewPanelProps {
  sessionId: string;
  sandboxMode?: SandboxMode;
}

const POLL_MS_READY = 15_000;
const POLL_MS_ACTIVE = 2_000;

function pollDelay(status: PreviewStatus["status"]): number {
  return status === "ready" ? POLL_MS_READY : POLL_MS_ACTIVE;
}

export function PreviewPanel({
  sessionId,
  sandboxMode = "local",
}: PreviewPanelProps) {
  const [preview, setPreview] = useState<PreviewStatus>({ status: "stopped" });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const previewRef = useRef(preview);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

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
          </div>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {exportError
              ? exportError
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
                <p>{preview.error}</p>
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
      </div>
    </section>
  );
}
