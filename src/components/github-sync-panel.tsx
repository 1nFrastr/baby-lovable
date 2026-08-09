"use client";

import {
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  Unlink,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useInvalidateSessionRuntime } from "@/lib/session/runtime-query";
import type { GithubSyncStatus } from "@/lib/git/types";

interface GithubSyncStatusResponse {
  linked: boolean;
  githubRepoName: string | null;
  githubSyncStatus: GithubSyncStatus;
  githubSyncError: string | null;
  installUrl: string | null;
  freestyleReady: boolean;
  authorized: boolean;
  githubLogin: string | null;
  authUrl: string | null;
  suggestedRepoName: string;
  createAndLinkAvailable: boolean;
}

interface GithubSyncPanelProps {
  sessionId: string;
  /** Only render for Daytona sessions. */
  visible?: boolean;
  /** From runtime projection — linked state without waiting for panel fetch. */
  linkedRepoName?: string | null;
}

type BusyPhase = "idle" | "auth" | "creating" | "linking" | "disconnecting";

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23.96-.27 1.98-.4 3-.4s2.04.13 3 .4c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.61-.01 2.91-.01 3.3 0 .32.22.7.82.58C20.56 21.8 24 17.3 24 12 24 5.37 18.63 0 12 0z" />
    </svg>
  );
}

function shortRepoLabel(fullName: string): string {
  const slash = fullName.indexOf("/");
  if (slash < 0) {
    return fullName;
  }
  const repo = fullName.slice(slash + 1);
  return repo.length > 18 ? `${repo.slice(0, 16)}…` : repo;
}

function readGithubSyncQuery(): {
  flag: string | null;
  error: string | null;
} {
  if (typeof window === "undefined") {
    return { flag: null, error: null };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    flag: params.get("github_sync"),
    error: params.get("github_sync_error"),
  };
}

function clearGithubSyncQuery(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (
    !url.searchParams.has("github_sync") &&
    !url.searchParams.has("github_sync_error")
  ) {
    return;
  }
  url.searchParams.delete("github_sync");
  url.searchParams.delete("github_sync_error");
  window.history.replaceState({}, "", url.pathname + url.search);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function applyStatusPatch(
  prev: GithubSyncStatusResponse | null,
  patch: Partial<GithubSyncStatusResponse>,
): GithubSyncStatusResponse {
  return {
    linked: patch.linked ?? prev?.linked ?? false,
    githubRepoName:
      patch.githubRepoName !== undefined
        ? patch.githubRepoName
        : (prev?.githubRepoName ?? null),
    githubSyncStatus: patch.githubSyncStatus ?? prev?.githubSyncStatus ?? "idle",
    githubSyncError:
      patch.githubSyncError !== undefined
        ? patch.githubSyncError
        : (prev?.githubSyncError ?? null),
    installUrl: patch.installUrl ?? prev?.installUrl ?? null,
    freestyleReady: patch.freestyleReady ?? prev?.freestyleReady ?? false,
    authorized: patch.authorized ?? prev?.authorized ?? false,
    githubLogin: patch.githubLogin ?? prev?.githubLogin ?? null,
    authUrl:
      patch.authUrl !== undefined ? patch.authUrl : (prev?.authUrl ?? null),
    suggestedRepoName: patch.suggestedRepoName ?? prev?.suggestedRepoName ?? "",
    createAndLinkAvailable:
      patch.createAndLinkAvailable ?? prev?.createAndLinkAvailable ?? false,
  };
}

export function GithubSyncPanel({
  sessionId,
  visible = true,
  linkedRepoName = null,
}: GithubSyncPanelProps) {
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const invalidateRuntime = useInvalidateSessionRuntime();
  const autoSyncTriggered = useRef(false);
  const abortRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyPhase, setBusyPhase] = useState<BusyPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [justLinked, setJustLinked] = useState(false);
  const [status, setStatus] = useState<GithubSyncStatusResponse | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const busy = busyPhase !== "idle";

  const loadStatus = useCallback(
    async (reconcile = false, options?: { clearError?: boolean }) => {
      setLoading(true);
      if (options?.clearError !== false) {
        setError(null);
      }
      try {
        const qs = reconcile ? "?reconcile=1" : "";
        const response = await fetch(
          `/api/sessions/${sessionId}/github-sync${qs}`,
        );
        const data = (await response.json().catch(() => null)) as
          | (GithubSyncStatusResponse & { error?: string })
          | null;
        if (!response.ok) {
          throw new Error(data?.error ?? `加载失败 (${response.status})`);
        }
        const next = data as GithubSyncStatusResponse;
        setStatus(next);
        if (next.githubRepoName) {
          setRepoInput(next.githubRepoName);
        } else if (next.suggestedRepoName && next.githubLogin) {
          setRepoInput(`${next.githubLogin}/${next.suggestedRepoName}`);
        }
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载状态失败");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  const waitForFreestyleReady = useCallback(
    async (maxAttempts = 24): Promise<GithubSyncStatusResponse | null> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (abortRef.current) {
          return null;
        }
        const next = await loadStatus(attempt === 0, { clearError: false });
        if (!next) {
          return null;
        }
        if (next.linked && next.githubRepoName) {
          return next;
        }
        if (next.freestyleReady) {
          return next;
        }
        await sleep(1250);
      }
      setError("代码库仍在准备中，请稍后再试");
      return null;
    },
    [loadStatus],
  );

  const handleCreateAndLink = useCallback(async () => {
    setBusyPhase("creating");
    setError(null);
    setJustLinked(false);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/github-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "create_and_link" }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        authUrl?: string;
        githubRepoName?: string | null;
        githubSyncStatus?: GithubSyncStatus;
        githubSyncError?: string | null;
      } | null;

      if (response.status === 401 && data?.authUrl) {
        setBusyPhase("auth");
        window.location.href = data.authUrl;
        return;
      }

      if (!response.ok) {
        if (data?.authUrl) {
          setBusyPhase("auth");
          window.location.href = data.authUrl;
          return;
        }
        throw new Error(data?.error ?? `同步失败 (${response.status})`);
      }

      setStatus((prev) =>
        applyStatusPatch(prev, {
          linked: true,
          githubRepoName: data?.githubRepoName ?? null,
          githubSyncStatus: data?.githubSyncStatus ?? "linked",
          githubSyncError: null,
          authorized: true,
          authUrl: null,
        }),
      );
      setJustLinked(true);
      invalidateRuntime(sessionId);
      void loadStatus(false, { clearError: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步失败");
      void loadStatus(false, { clearError: false });
    } finally {
      setBusyPhase("idle");
    }
  }, [sessionId, invalidateRuntime, loadStatus]);

  // Prefetch so the trigger / first open reflect auth + link state.
  useEffect(() => {
    if (!visible) {
      return;
    }
    abortRef.current = false;
    setStatus(null);
    setError(null);
    setJustLinked(false);
    setAdvancedOpen(false);
    setBusyPhase("idle");
    queueMicrotask(() => {
      void loadStatus(false);
    });
    return () => {
      abortRef.current = true;
    };
  }, [visible, loadStatus, sessionId]);

  // Soft refresh when opening (reconcile Freestyle ↔ stored link).
  useEffect(() => {
    if (!visible || !open) {
      return;
    }
    queueMicrotask(() => {
      void loadStatus(true, { clearError: false });
    });
  }, [visible, open, loadStatus, sessionId]);

  // After OAuth callback: ?github_sync=1 → open panel, wait for Freestyle, auto create.
  useEffect(() => {
    if (!visible || autoSyncTriggered.current) {
      return;
    }
    const query = readGithubSyncQuery();
    if (query.flag === "error") {
      autoSyncTriggered.current = true;
      queueMicrotask(() => {
        setOpen(true);
        setError(query.error ?? "GitHub 授权失败，请重试");
        clearGithubSyncQuery();
      });
      return;
    }
    if (query.flag !== "1") {
      return;
    }
    autoSyncTriggered.current = true;
    queueMicrotask(() => {
      setOpen(true);
      setBusyPhase("creating");
      void (async () => {
        clearGithubSyncQuery();
        const ready = await waitForFreestyleReady();
        if (!ready || abortRef.current) {
          setBusyPhase("idle");
          return;
        }
        if (ready.linked && ready.githubRepoName) {
          setJustLinked(true);
          setBusyPhase("idle");
          invalidateRuntime(sessionId);
          return;
        }
        await handleCreateAndLink();
      })();
    });
  }, [
    visible,
    waitForFreestyleReady,
    handleCreateAndLink,
    invalidateRuntime,
    sessionId,
  ]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!justLinked) {
      return;
    }
    const timer = window.setTimeout(() => setJustLinked(false), 2400);
    return () => window.clearTimeout(timer);
  }, [justLinked]);

  if (!visible) {
    return null;
  }

  // Prefer local status once loaded; fall back to runtime projection for instant chrome.
  const linkedName = status
    ? status.linked && status.githubRepoName
      ? status.githubRepoName
      : null
    : linkedRepoName || null;
  const linked = Boolean(linkedName);
  const hasError = Boolean(
    error || status?.githubSyncStatus === "error" || status?.githubSyncError,
  );
  const displayError = error ?? status?.githubSyncError ?? null;
  const freestyleReady = linked || status?.freestyleReady === true;
  const canPrimary =
    !busy &&
    Boolean(status) &&
    freestyleReady &&
    Boolean(status?.createAndLinkAvailable || status?.authUrl);

  const handleConnectExisting = async () => {
    const trimmed = repoInput.trim();
    if (!trimmed.includes("/")) {
      setError("格式：owner/repo");
      return;
    }
    setBusyPhase("linking");
    setError(null);
    setJustLinked(false);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/github-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubRepoName: trimmed }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        githubRepoName?: string | null;
        githubSyncStatus?: GithubSyncStatus;
        githubSyncError?: string | null;
      } | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `连接失败 (${response.status})`);
      }
      setStatus((prev) =>
        applyStatusPatch(prev, {
          linked: true,
          githubRepoName: data?.githubRepoName ?? trimmed,
          githubSyncStatus: data?.githubSyncStatus ?? "linked",
          githubSyncError: null,
        }),
      );
      setJustLinked(true);
      setAdvancedOpen(false);
      invalidateRuntime(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接失败");
      void loadStatus(false, { clearError: false });
    } finally {
      setBusyPhase("idle");
    }
  };

  const handleDisconnect = async () => {
    setBusyPhase("disconnecting");
    setError(null);
    setJustLinked(false);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/github-sync`, {
        method: "DELETE",
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `断开失败 (${response.status})`);
      }
      setStatus((prev) =>
        applyStatusPatch(prev, {
          linked: false,
          githubRepoName: null,
          githubSyncStatus: "idle",
          githubSyncError: null,
        }),
      );
      invalidateRuntime(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "断开失败");
      void loadStatus(false, { clearError: false });
    } finally {
      setBusyPhase("idle");
    }
  };

  const handleTriggerClick = () => {
    if (
      !linked &&
      !busy &&
      status &&
      !status.authorized &&
      status.authUrl &&
      freestyleReady
    ) {
      setBusyPhase("auth");
      window.location.href = status.authUrl;
      return;
    }
    setOpen((value) => !value);
  };

  const handlePrimaryClick = () => {
    if (status?.authUrl && !status.authorized) {
      setBusyPhase("auth");
      window.location.href = status.authUrl;
      return;
    }
    void handleCreateAndLink();
  };

  const primaryLabel =
    busyPhase === "auth"
      ? "跳转授权…"
      : busyPhase === "creating"
        ? "正在创建仓库…"
        : status?.authorized
          ? "创建并连接"
          : status?.githubLogin
            ? "重新授权安装"
            : "授权并连接";

  const suggestedFull =
    status?.githubLogin && status.suggestedRepoName
      ? `${status.githubLogin}/${status.suggestedRepoName}`
      : status?.suggestedRepoName
        ? status.suggestedRepoName
        : null;

  const triggerTitle = linked
    ? linkedName!
    : hasError
      ? (displayError ?? "GitHub 同步异常")
      : !status?.authorized && status?.authUrl
        ? "授权 GitHub"
        : "连接到 GitHub";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={handleTriggerClick}
        title={triggerTitle}
        className={`inline-flex max-w-[11rem] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
          hasError && !linked
            ? "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
            : linked
              ? "border-emerald-300 text-zinc-800 hover:bg-emerald-50 dark:border-emerald-800 dark:text-zinc-100 dark:hover:bg-emerald-950/40"
              : "border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        }`}
      >

        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={2} />
        ) : (
          <GitHubMark className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">
          {linked ? shortRepoLabel(linkedName!) : "GitHub"}
        </span>
        {linked && !busy ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
            aria-hidden
          />
        ) : null}
        {hasError && !linked && !busy ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
            aria-hidden
          />
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="GitHub"
          className="absolute right-0 top-full z-40 mt-2 w-[20rem] rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-950"
        >
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <GitHubMark className="h-3.5 w-3.5 shrink-0 text-zinc-700 dark:text-zinc-200" />
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                GitHub
              </p>
              {status?.githubLogin ? (
                <span className="truncate font-mono text-[10px] text-zinc-400">
                  @{status.githubLogin}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>

          {loading && !status ? (
            <p className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
              加载中…
            </p>
          ) : null}

          {!freestyleReady && !linked ? (
            <p className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
              代码库准备中…
            </p>
          ) : null}

          {linked && linkedName ? (
            <div className="space-y-2.5">
              <div className="flex items-start gap-2 rounded-lg bg-zinc-50 px-2.5 py-2 dark:bg-zinc-900">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <a
                    href={`https://github.com/${linkedName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-zinc-800 hover:underline dark:text-zinc-200"
                  >
                    <span className="truncate">{linkedName}</span>
                    <ExternalLink
                      className="h-3 w-3 shrink-0 opacity-60"
                      strokeWidth={2}
                    />
                  </a>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                    {justLinked ? (
                      <>
                        <Check className="h-3 w-3" strokeWidth={2} />
                        已连接
                      </>
                    ) : (
                      "双向同步已开启"
                    )}
                  </p>
                </div>
              </div>
              {status && !status.authorized && status.authUrl ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBusyPhase("auth");
                    window.location.href = status.authUrl!;
                  }}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                >
                  {busyPhase === "auth" ? (
                    <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                  ) : (
                    <GitHubMark className="h-3 w-3" />
                  )}
                  重新授权安装
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void handleDisconnect();
                }}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 transition hover:text-zinc-800 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                {busyPhase === "disconnecting" ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                ) : (
                  <Unlink className="h-3 w-3" strokeWidth={2} />
                )}
                断开连接
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                disabled={!canPrimary}
                title={
                  busy
                    ? undefined
                    : !status
                      ? "加载中…"
                      : !freestyleReady
                        ? "代码库尚未就绪"
                        : !status.createAndLinkAvailable && !status.authUrl
                          ? "暂不可用"
                          : undefined
                }
                onClick={handlePrimaryClick}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                ) : (
                  <GitHubMark className="h-3 w-3" />
                )}
                {primaryLabel}
              </button>

              {suggestedFull && !busy ? (
                <p className="truncate text-center font-mono text-[10px] text-zinc-400">
                  {suggestedFull}
                </p>
              ) : null}

              {!status?.createAndLinkAvailable && status ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  一键创建暂不可用，可连接已有仓库。
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                <ChevronDown
                  className={`h-3 w-3 transition ${advancedOpen ? "rotate-180" : ""}`}
                  strokeWidth={2}
                />
                连接已有仓库
              </button>

              {advancedOpen ? (
                <div className="space-y-2 rounded-lg border border-zinc-100 p-2 dark:border-zinc-800">
                  {status?.installUrl ? (
                    <a
                      href={status.installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                    >
                      安装 App
                      <ExternalLink className="h-3 w-3" strokeWidth={2} />
                    </a>
                  ) : null}
                  <input
                    type="text"
                    value={repoInput}
                    onChange={(event) => setRepoInput(event.target.value)}
                    placeholder="owner/repo"
                    disabled={busy || !freestyleReady}
                    aria-label="仓库 owner/repo"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-900 outline-none ring-sky-500 placeholder:text-zinc-400 focus:ring-2 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <button
                    type="button"
                    disabled={
                      busy || !repoInput.trim() || !freestyleReady
                    }
                    onClick={() => {
                      void handleConnectExisting();
                    }}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  >
                    {busyPhase === "linking" ? (
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        strokeWidth={2}
                      />
                    ) : null}
                    连接
                  </button>
                </div>
              ) : null}
            </div>
          )}

          {displayError ? (
            <p
              className="mt-2 text-[11px] leading-snug text-red-600 dark:text-red-400"
              role="alert"
            >
              {displayError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
