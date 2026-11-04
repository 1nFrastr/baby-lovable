"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CreditCard, Database, Link2, Rocket, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import type { SessionIntegrationsProjection } from "@/lib/integrations/types";

import { BackendAuthentication } from "./backend-authentication";
import { BackendConnections } from "./backend-connections";
import { BackendDatabasePanel } from "./backend-database-panel";
import { BackendPublish } from "./backend-publish";
import { BackendEmpty, BackendError, BackendLoading, backendPrimaryButtonClass, backendQueryKey, backendRequest } from "./backend-ui";

export type BackendSection = "database" | "authentication" | "connections" | "stripe" | "deploy";

const sections = [
  { id: "database", label: "Database", icon: Database },
  { id: "authentication", label: "Authentication", icon: ShieldCheck },
  { id: "connections", label: "Connections", icon: Link2 },
  { id: "stripe", label: "Payments", icon: CreditCard },
  { id: "deploy", label: "Publish", icon: Rocket },
] as const;

interface BackendPanelProps {
  sessionId: string;
  refreshKey: number;
  active: boolean;
  onBusyChange?: (busy: boolean) => void;
}

export function BackendPanel({ sessionId, ...props }: BackendPanelProps) {
  return <BackendPanelContent key={sessionId} sessionId={sessionId} {...props} />;
}

function BackendPanelContent({ sessionId, refreshKey, active, onBusyChange }: BackendPanelProps) {
  const [section, setSection] = useState<BackendSection>("database");
  const [callbackNotice, setCallbackNotice] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [sectionBusy, setSectionBusy] = useState(false);
  const { data: status, error, isPending, isFetching, refetch } = useQuery({
    queryKey: backendQueryKey(sessionId),
    queryFn: ({ signal }) => backendRequest<SessionIntegrationsProjection>(`/api/sessions/${encodeURIComponent(sessionId)}/integrations`, { signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: active,
    refetchInterval: (query) => active && query.state.data?.deploy.status === "deploying" ? 5_000 : false,
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const callback = url.searchParams.get("backend");
    if (!callback) return;
    const vercelCallback = callback === "vercel_connected" || (callback === "error" && url.searchParams.get("backend_provider") === "vercel");
    const previewError = url.searchParams.get("backend_preview") === "error";
    queueMicrotask(() => {
      setSection(vercelCallback ? "deploy" : callback === "stripe_connected" ? "stripe" : "connections");
      if (callback === "error") setCallbackError(vercelCallback ? "Vercel authorization could not be completed. Connect Vercel again to retry." : "Account authorization could not be completed. Please connect again.");
      else setCallbackNotice(vercelCallback ? "Vercel connected. Review your Team selection below before publishing." : callback === "stripe_connected" ? "Stripe connected. Your payment settings are ready below." : "Supabase account connected. Choose a project for this app.");
      if (previewError && !vercelCallback) setCallbackError("Account connected, but the preview could not refresh. Use Refresh preview connections to retry.");
    });
    void refetch();
    url.searchParams.delete("backend");
    url.searchParams.delete("backend_provider");
    url.searchParams.delete("backend_error");
    url.searchParams.delete("backend_preview");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [refetch]);

  useEffect(() => {
    if (refreshKey > 0) void refetch();
  }, [refreshKey, refetch]);

  useEffect(() => {
    onBusyChange?.(isFetching || sectionBusy);
    return () => onBusyChange?.(false);
  }, [isFetching, sectionBusy, onBusyChange]);

  const linked = status?.supabase.status === "linked";
  const projectRef = status?.supabase.projectRef;
  const dashboardUrl = projectRef ? `https://supabase.com/dashboard/project/${encodeURIComponent(projectRef)}` : null;
  const changeSection = (value: BackendSection) => {
    setSection(value);
    setCallbackNotice(null);
    setCallbackError(null);
  };

  return (
    <div className="@container/backend flex h-full min-h-0 flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-4 py-4 dark:border-zinc-800 @[600px]/backend:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h2 className="text-sm font-semibold tracking-tight">Backend</h2><span className="rounded-md border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-800">Supabase</span></div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Manage your app’s data, authentication, and services.</p>
        </div>
        {linked ? <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"><span className="size-1.5 rounded-full bg-emerald-500" />Connected</span> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col @[600px]/backend:flex-row">
        <aside className="shrink-0 border-b border-zinc-200 bg-zinc-50/60 p-2 dark:border-zinc-800 dark:bg-zinc-900/30 @[600px]/backend:flex @[600px]/backend:w-44 @[600px]/backend:flex-col @[600px]/backend:border-r @[600px]/backend:border-b-0 @[600px]/backend:p-3">
          <nav aria-label="Backend sections" className="flex gap-1 overflow-x-auto @[600px]/backend:flex-col">
            {sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={section === id ? "page" : undefined} onClick={() => changeSection(id)} className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${section === id ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200/80 dark:bg-zinc-800 dark:text-white dark:ring-zinc-700" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-white"}`}><Icon className={`size-3.5 ${section === id && (id === "database" || id === "authentication") ? "text-emerald-600 dark:text-emerald-400" : ""}`} strokeWidth={1.75} />{label}</button>)}
          </nav>
          {linked ? <div className="mt-auto hidden min-w-0 border-t border-zinc-200 px-2 pt-4 pb-1 dark:border-zinc-800 @[600px]/backend:block"><p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Connected project</p><p className="mt-2 truncate text-xs font-medium" title={status.supabase.projectName ?? undefined}>{status.supabase.projectName ?? projectRef}</p><p className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={projectRef ?? undefined}>{projectRef}</p>{dashboardUrl ? <a href={dashboardUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200">Open Supabase<ArrowUpRight className="size-3" /></a> : null}</div> : null}
        </aside>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {callbackError ? <div className="px-4 pt-4"><BackendError error={new Error(callbackError)} /></div> : null}
          {callbackNotice ? <p role="status" className="mx-4 mt-4 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">{callbackNotice}</p> : null}
          {error ? <div className="p-4"><BackendError error={error} onRetry={() => void refetch()} /></div> : null}
          {isPending ? <BackendLoading /> : status ? (
            section === "deploy" ? <BackendPublish sessionId={sessionId} status={status} onBusyChange={setSectionBusy} /> : section === "connections" || section === "stripe" ? <BackendConnections sessionId={sessionId} status={status} section={section} /> : !linked ? <BackendEmpty title="Connect your app’s backend" action={<button type="button" className={backendPrimaryButtonClass} onClick={() => changeSection("connections")}><Link2 className="size-3.5" />Connect Supabase</button>}>Connect a Supabase project to explore its database and manage sign-in settings.</BackendEmpty> : section === "database" ? <BackendDatabasePanel key={projectRef} sessionId={sessionId} projectRef={projectRef ?? null} refreshKey={refreshKey} active={active} onBusyChange={setSectionBusy} /> : <BackendAuthentication key={projectRef} sessionId={sessionId} projectRef={projectRef ?? null} refreshKey={refreshKey} active={active} onBusyChange={setSectionBusy} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
