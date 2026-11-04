"use client";

import { Database, Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export const backendButtonClass = "inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:pointer-events-none disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
export const backendPrimaryButtonClass = "inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";
export const backendInputClass = "w-full min-w-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/10 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

export async function backendRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : "Could not complete this request. Please try again.");
  }
  return data as T;
}

export function backendQueryKey(sessionId: string) {
  return ["session-backend", sessionId] as const;
}

export function safeBackendUrl(value: string | null | undefined): string | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function BackendLoading({ children = "Loading project…" }: { children?: ReactNode }) {
  return <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-xs text-zinc-500"><Loader2 className="size-4 animate-spin" aria-hidden />{children}</div>;
}

export function BackendError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-xs leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
    <p>{error.message}</p>
    {onRetry ? <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 font-medium underline underline-offset-4"><RefreshCw className="size-3" />Try again</button> : null}
  </div>;
}

export function BackendEmpty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
    <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"><Database className="size-5 text-zinc-400" strokeWidth={1.5} /></div>
    <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h3>
    <div className="mt-2 max-w-sm text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{children}</div>
    {action ? <div className="mt-5">{action}</div> : null}
  </div>;
}
