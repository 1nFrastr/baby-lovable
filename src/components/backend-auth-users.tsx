"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, RefreshCw, Search, Users, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { SupabaseUsersResponse } from "@/lib/integrations/supabase-admin-types";

import { BackendError, BackendLoading, backendButtonClass, backendInputClass, backendPrimaryButtonClass, backendRequest } from "./backend-ui";

interface BackendAuthUsersProps {
  sessionId: string;
  projectRef: string | null;
  refreshKey: number;
  active: boolean;
  onBusyChange: (busy: boolean) => void;
}

function userDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function BackendAuthUsers({ sessionId, projectRef, refreshKey, active, onBusyChange }: BackendAuthUsersProps) {
  const [searchInput, setSearchInput] = useState("");
  const [options, setOptions] = useState({ offset: 0, pageSize: 25, search: "" });
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ["session-backend-users", sessionId, projectRef, options],
    queryFn: ({ signal }) => backendRequest<SupabaseUsersResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/integrations/supabase/users`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options), signal,
    }),
    enabled: active,
    staleTime: 15_000,
    gcTime: 0,
    refetchOnWindowFocus: active,
    retry: false,
  });

  useEffect(() => { if (refreshKey > 0 && active) void refetch(); }, [refreshKey, active, refetch]);
  useEffect(() => { onBusyChange(isFetching); return () => onBusyChange(false); }, [isFetching, onBusyChange]);

  const users = data?.users ?? [];
  const clearSearch = () => {
    setSearchInput("");
    setOptions((current) => ({ ...current, search: "", offset: 0 }));
  };

  return (
    <div className="space-y-4 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <form role="search" aria-label="Search app users" className="flex min-w-0 flex-1 gap-2" onSubmit={(event) => {
          event.preventDefault();
          setOptions((current) => ({ ...current, offset: 0, search: searchInput.trim() }));
        }}>
          <div className="relative min-w-24 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-zinc-400" />
            <input type="search" aria-label="Search users by email or ID" placeholder="Search by email or user ID…" maxLength={200} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} className={`${backendInputClass} pl-8`} />
          </div>
          <button type="submit" className={backendPrimaryButtonClass}>Search</button>
        </form>
        <button type="button" aria-label="Refresh users" disabled={isFetching} onClick={() => void refetch()} className={backendButtonClass}><RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} /></button>
      </div>
      {options.search ? <div className="flex items-center gap-2 text-[11px] text-zinc-500"><span className="min-w-0 truncate">Results for “{options.search}”</span><button type="button" onClick={clearSearch} aria-label="Clear user search" className="shrink-0 rounded p-1 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"><X className="size-3" /></button></div> : null}
      {error ? <BackendError error={error} onRetry={() => void refetch()} /> : null}
      {isPending ? <BackendLoading>Loading users…</BackendLoading> : data ? (
        <>
          <div className="max-h-[min(60dvh,36rem)] overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800" aria-busy={isFetching}>
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Registered users in this app</caption>
              <thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50 text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900"><tr><th scope="col" className="px-3 py-3 font-medium">User</th><th scope="col" className="px-3 py-3 font-medium whitespace-nowrap">Email status</th><th scope="col" className="px-3 py-3 font-medium whitespace-nowrap">Created</th><th scope="col" className="px-3 py-3 font-medium whitespace-nowrap">Last sign-in</th></tr></thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {users.length === 0 ? <tr><td colSpan={4} className="px-6 py-14 text-center"><Users className="mx-auto mb-3 size-6 text-zinc-300 dark:text-zinc-600" strokeWidth={1.5} /><p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{options.search ? "No matching users" : options.offset > 0 ? "No users on this page" : "No users yet"}</p><p className="mt-1.5 text-[11px] text-zinc-500">{options.search ? "Try another email or user ID, or clear your search." : options.offset > 0 ? "Return to the previous page or refresh the list." : "People will appear here after signing up in your app."}</p></td></tr> : users.map((user) => (
                  <tr key={user.id} className="align-top hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40">
                    <td className="min-w-52 px-3 py-3"><p className="max-w-64 font-medium break-all text-zinc-800 dark:text-zinc-200">{user.email || (user.isAnonymous ? "Anonymous user" : "No email address")}</p><p className="mt-1 max-w-64 font-mono text-[10px] break-all text-zinc-400" title={user.id}>{user.id}</p></td>
                    <td className="px-3 py-3"><span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] whitespace-nowrap ${user.email && user.emailConfirmedAt ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" : user.email ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>{user.email && user.emailConfirmedAt ? <><Check className="size-3" />Verified</> : user.email ? "Unverified" : "No email"}</span></td>
                    <td className="px-3 py-3 text-[11px] text-zinc-500"><time dateTime={user.createdAt ?? undefined} title={user.createdAt ?? undefined} className="block min-w-24">{userDate(user.createdAt)}</time></td>
                    <td className="px-3 py-3 text-[11px] text-zinc-500">{user.lastSignInAt ? <time dateTime={user.lastSignInAt} title={user.lastSignInAt} className="block min-w-24">{userDate(user.lastSignInAt)}</time> : <span className="text-zinc-400">Never</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-[11px] text-zinc-500">{isFetching ? "Refreshing users…" : users.length ? `Users ${(options.offset + 1).toLocaleString()}–${(options.offset + users.length).toLocaleString()}` : "0 users"}</p>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[10px] text-zinc-500"><span className="hidden @[600px]/backend:inline">Per page</span><select aria-label="Users per page" value={options.pageSize} onChange={(event) => setOptions((current) => ({ ...current, offset: 0, pageSize: Number(event.target.value) }))} className={`${backendInputClass} w-auto px-1.5 py-1`}>{[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
              <button type="button" aria-label="Previous users page" disabled={options.offset === 0 || isFetching} onClick={() => setOptions((current) => ({ ...current, offset: Math.max(0, current.offset - current.pageSize) }))} className={`${backendButtonClass} px-2 py-1.5`}><ChevronLeft className="size-3.5" /></button>
              <button type="button" aria-label="Next users page" disabled={!data.hasMore || isFetching || options.offset + options.pageSize > 100_000} onClick={() => setOptions((current) => ({ ...current, offset: current.offset + current.pageSize }))} className={`${backendButtonClass} px-2 py-1.5`}><ChevronRight className="size-3.5" /></button>
            </div>
          </div>
          <p className="text-[10px] leading-relaxed text-zinc-400">Read-only user directory · Newest accounts first.</p>
        </>
      ) : null}
    </div>
  );
}
