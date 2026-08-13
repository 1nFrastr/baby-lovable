"use client";

import {
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Unlink,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type {
  GithubSyncStatus,
  SourceControlProjection,
} from "@/lib/git/types";
import { useInvalidateSessionRuntime } from "@/lib/session/runtime-query";

interface GithubSyncStatusResponse {
  linked: boolean;
  githubRepoName: string | null;
  githubSyncStatus: GithubSyncStatus;
  githubSyncError: string | null;
  freestyleReady: boolean;
  installed: boolean;
  githubLogin: string | null;
  installUrl: string | null;
  configureUrl: string | null;
  githubIdentityRequired: boolean;
}

interface GithubRepositoryOption {
  id: number;
  fullName: string;
  name: string;
  ownerLogin: string;
  private: boolean;
  htmlUrl: string;
  createdAt: string;
  size: number;
}

interface GithubSyncPanelProps {
  sessionId: string;
  /** Only render for Daytona sessions. */
  visible?: boolean;
  /** From runtime projection — linked state without waiting for panel fetch. */
  linkedRepoName?: string | null;
  /** Live runtime state — unlocks linking as soon as provisioning is ready. */
  sourceControlStatus?: SourceControlProjection["status"] | null;
}

type BusyPhase = "idle" | "auth" | "linking" | "disconnecting";

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
  const repo = fullName.split("/").at(-1) ?? fullName;
  return repo.length > 18 ? `${repo.slice(0, 16)}…` : repo;
}

function newGithubRepositoryUrl(sessionId: string): string {
  const shortId = sessionId.replace(/^sess_/, "").slice(0, 10) || "app";
  const params = new URLSearchParams({
    name: `baby-lovable-${shortId}`,
    description: "Built with baby-lovable",
  });
  return `https://github.com/new?${params.toString()}`;
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
  url.searchParams.delete("github_sync");
  url.searchParams.delete("github_sync_error");
  window.history.replaceState({}, "", url.pathname + url.search);
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
    freestyleReady: patch.freestyleReady ?? prev?.freestyleReady ?? false,
    installed: patch.installed ?? prev?.installed ?? false,
    githubLogin:
      patch.githubLogin !== undefined
        ? patch.githubLogin
        : (prev?.githubLogin ?? null),
    installUrl:
      patch.installUrl !== undefined ? patch.installUrl : (prev?.installUrl ?? null),
    configureUrl:
      patch.configureUrl !== undefined
        ? patch.configureUrl
        : (prev?.configureUrl ?? null),
    githubIdentityRequired:
      patch.githubIdentityRequired ?? prev?.githubIdentityRequired ?? false,
  };
}

export function GithubSyncPanel({
  sessionId,
  visible = true,
  linkedRepoName = null,
  sourceControlStatus = null,
}: GithubSyncPanelProps) {
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const callbackHandled = useRef(false);
  const invalidateRuntime = useInvalidateSessionRuntime();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [busyPhase, setBusyPhase] = useState<BusyPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [justLinked, setJustLinked] = useState(false);
  const [status, setStatus] = useState<GithubSyncStatusResponse | null>(null);
  const [repositories, setRepositories] =
    useState<GithubRepositoryOption[] | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");

  const busy = busyPhase !== "idle";

  const loadStatus = useCallback(
    async (reconcile = false, clearError = true) => {
      setLoading(true);
      if (clearError) {
        setError(null);
      }
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/github-sync${reconcile ? "?reconcile=1" : ""}`,
        );
        const data = (await response.json().catch(() => null)) as
          | (GithubSyncStatusResponse & { error?: string })
          | null;
        if (!response.ok) {
          throw new Error(data?.error ?? `加载失败 (${response.status})`);
        }
        const next = data as GithubSyncStatusResponse;
        setStatus(next);
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

  const loadRepositories = useCallback(
    async (clearError = true, selectFirstRepository = false) => {
      setRepositoriesLoading(true);
      if (clearError) {
        setError(null);
      }
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/github-sync/repositories`,
        );
        const data = (await response.json().catch(() => null)) as {
          repositories?: GithubRepositoryOption[];
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(data?.error ?? `加载仓库失败 (${response.status})`);
        }
        const next = data?.repositories ?? [];
        setRepositories(next);
        setSelectedRepositoryId((current) => {
          if (
            !selectFirstRepository &&
            current &&
            next.some((repo) => String(repo.id) === current)
          ) {
            return current;
          }
          return next[0] ? String(next[0].id) : "";
        });
      } catch (err) {
        setRepositories([]);
        setSelectedRepositoryId("");
        setError(err instanceof Error ? err.message : "加载仓库失败");
        void loadStatus(false, false);
      } finally {
        setRepositoriesLoading(false);
      }
    },
    [loadStatus, sessionId],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }
    callbackHandled.current = false;
    queueMicrotask(() => {
      setStatus(null);
      setRepositories(null);
      setSelectedRepositoryId("");
      setError(null);
      setJustLinked(false);
      setBusyPhase("idle");
      void loadStatus(false);
    });
  }, [visible, loadStatus, sessionId]);

  useEffect(() => {
    if (!visible || !open) {
      return;
    }
    queueMicrotask(() => void loadStatus(true, false));
  }, [visible, open, loadStatus, sessionId]);

  useEffect(() => {
    if (
      open &&
      status?.installed &&
      !status.linked &&
      repositories === null &&
      !repositoriesLoading
    ) {
      queueMicrotask(() => void loadRepositories(false));
    }
  }, [
    open,
    status?.installed,
    status?.linked,
    repositories,
    repositoriesLoading,
    loadRepositories,
  ]);

  useEffect(() => {
    if (!visible || callbackHandled.current) {
      return;
    }
    const query = readGithubSyncQuery();
    if (!query.flag) {
      return;
    }
    callbackHandled.current = true;
    queueMicrotask(() => {
      setOpen(true);
      if (query.flag === "error") {
        setError(query.error ?? "GitHub App 安装失败，请重试");
      } else if (query.flag === "installed" || query.flag === "1") {
        setRepositories(null);
        void loadStatus(false);
      }
      clearGithubSyncQuery();
    });
  }, [visible, loadStatus]);

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

  const linkedName = status
    ? status.linked && status.githubRepoName
      ? status.githubRepoName
      : null
    : linkedRepoName || null;
  const linked = Boolean(linkedName);
  const displayError = error ?? status?.githubSyncError ?? null;
  const hasError = Boolean(displayError || status?.githubSyncStatus === "error");
  const runtimeFreestyleReady =
    sourceControlStatus === "ready" ||
    sourceControlStatus === "syncing" ||
    sourceControlStatus === "synced" ||
    sourceControlStatus === "conflict";
  const freestyleReady =
    linked || status?.freestyleReady === true || runtimeFreestyleReady;

  const handleLink = async () => {
    const repositoryId = Number(selectedRepositoryId);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      setError("请选择一个 GitHub 仓库");
      return;
    }
    setBusyPhase("linking");
    setError(null);
    setJustLinked(false);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/github-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        githubRepoName?: string | null;
        githubSyncStatus?: GithubSyncStatus;
      } | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `连接失败 (${response.status})`);
      }
      setStatus((prev) =>
        applyStatusPatch(prev, {
          linked: true,
          githubRepoName: data?.githubRepoName ?? null,
          githubSyncStatus: data?.githubSyncStatus ?? "linked",
          githubSyncError: null,
        }),
      );
      setJustLinked(true);
      invalidateRuntime(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接失败");
      void loadStatus(false, false);
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
      setRepositories(null);
      invalidateRuntime(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "断开失败");
      void loadStatus(false, false);
    } finally {
      setBusyPhase("idle");
    }
  };

  const startInstall = () => {
    if (!status?.installUrl) {
      setError(
        status?.githubIdentityRequired
          ? "请先退出当前账号，并使用 GitHub 登录"
          : "GitHub App 尚未配置",
      );
      return;
    }
    setBusyPhase("auth");
    window.location.href = status.installUrl;
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        title={linked ? linkedName! : "连接到 GitHub"}
        className={`inline-flex max-w-[11rem] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
          hasError && !linked
            ? "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
            : linked
              ? "border-emerald-300 text-zinc-800 hover:bg-emerald-50 dark:border-emerald-800 dark:text-zinc-100 dark:hover:bg-emerald-950/40"
              : "border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        }`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <GitHubMark className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">
          {linked ? shortRepoLabel(linkedName!) : "GitHub"}
        </span>
        {linked && !busy ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="GitHub"
          className="absolute right-0 top-full z-40 mt-2 w-[21rem] rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-950"
        >
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <GitHubMark className="h-3.5 w-3.5 text-zinc-700 dark:text-zinc-200" />
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
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {loading && !status ? (
            <p className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              加载中…
            </p>
          ) : null}

          {!freestyleReady && !linked ? (
            <p className="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              代码库准备中，请稍后再选择 GitHub 仓库。
            </p>
          ) : null}

          {linked && linkedName ? (
            <div className="space-y-2.5">
              <div className="rounded-lg bg-zinc-50 px-2.5 py-2 dark:bg-zinc-900">
                <a
                  href={`https://github.com/${linkedName}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-zinc-800 hover:underline dark:text-zinc-200"
                >
                  <span className="truncate">{linkedName}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                </a>
                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                  {justLinked ? <Check className="h-3 w-3" /> : null}
                  {justLinked ? "已连接" : "双向同步已开启"}
                </p>
              </div>
              {!status?.installed && status?.installUrl ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={startInstall}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  重新安装 GitHub App
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleDisconnect()}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:text-zinc-400"
              >
                {busyPhase === "disconnecting" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Unlink className="h-3 w-3" />
                )}
                断开连接
              </button>
            </div>
          ) : status ? (
            <div className="space-y-2.5">
              {status.githubIdentityRequired ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-300">
                  请使用 GitHub 登录，才能校验个人仓库 installation 的归属。
                </p>
              ) : !status.installed ? (
                <>
                  <p className="text-xs text-zinc-600 dark:text-zinc-300">
                    安装 GitHub App，并在 GitHub 中选择要开放的已有仓库。
                  </p>
                  <button
                    type="button"
                    disabled={busy || !status.installUrl || !freestyleReady}
                    onClick={startInstall}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {busyPhase === "auth" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <GitHubMark className="h-3 w-3" />
                    )}
                    安装 GitHub App
                  </button>
                </>
              ) : (
                <>
                  <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                    选择空仓库
                    <select
                      value={selectedRepositoryId}
                      onChange={(event) =>
                        setSelectedRepositoryId(event.target.value)
                      }
                      disabled={
                        busy || repositoriesLoading || !freestyleReady
                      }
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-900 outline-none ring-sky-500 focus:ring-2 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    >
                      {repositoriesLoading ? (
                        <option value="">正在加载仓库…</option>
                      ) : repositories?.length ? (
                        repositories.map((repo) => (
                          <option key={repo.id} value={repo.id}>
                            {repo.fullName}
                            {repo.private ? " · private" : ""}
                          </option>
                        ))
                      ) : (
                        <option value="">没有可连接的空仓库</option>
                      )}
                    </select>
                  </label>
                  {!repositoriesLoading &&
                  repositories !== null &&
                  repositories.length === 0 ? (
                    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                      请创建仓库时不要添加 README、.gitignore 或 License，然后刷新列表。
                    </p>
                  ) : null}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={repositoriesLoading || busy}
                      onClick={() => void loadRepositories(true, true)}
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:text-zinc-400"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${repositoriesLoading ? "animate-spin" : ""}`}
                      />
                      刷新
                    </button>
                    <a
                      href={newGithubRepositoryUrl(sessionId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400"
                    >
                      <ExternalLink className="h-3 w-3" />
                      新建空仓库
                    </a>
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      repositoriesLoading ||
                      !selectedRepositoryId ||
                      !freestyleReady
                    }
                    onClick={() => void handleLink()}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {busyPhase === "linking" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    连接所选仓库
                  </button>
                </>
              )}
            </div>
          ) : null}

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
