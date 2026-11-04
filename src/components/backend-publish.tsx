"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2, RefreshCw, Rocket, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { SessionIntegrationsProjection } from "@/lib/integrations/types";

import { BackendError, backendButtonClass, backendInputClass, backendPrimaryButtonClass, backendQueryKey, backendRequest, safeBackendUrl } from "./backend-ui";

interface VercelTeam { id: string; slug: string; name: string }

function readablePhase(phase: string | null | undefined) {
  if (!phase) return null;
  const words = phase.replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function BackendPublish({ sessionId, status, onBusyChange }: { sessionId: string; status: SessionIntegrationsProjection; onBusyChange?: (busy: boolean) => void }) {
  const queryClient = useQueryClient();
  const controllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftTeamId, setDraftTeamId] = useState<string | null>(null);
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/integrations`;
  const { vercel, deploy } = status;
  const connected = vercel?.connected === true;
  const configured = status.connect?.vercel === true;
  const publishing = deploy.status === "deploying";
  const projectBound = Boolean(vercel?.projectId);
  const teamId = draftTeamId ?? vercel?.teamId ?? "";
  const locked = busy || publishing;
  const legacy = deploy.provider === "freestyle";
  const publicUrl = legacy ? undefined : safeBackendUrl(deploy.url);
  const legacyUrl = safeBackendUrl(status.legacyPublication?.url ?? (legacy ? deploy.url : null));
  const dashboardUrl = safeBackendUrl(vercel?.dashboardUrl);
  const phase = readablePhase(deploy.phase);
  const teamsQuery = useQuery({
    queryKey: ["session-backend-vercel", sessionId, connected],
    queryFn: ({ signal }) => backendRequest<{ teams: VercelTeam[] }>(`${endpoint}/vercel`, { signal }),
    enabled: connected && !projectBound,
    staleTime: 30_000,
    retry: false,
  });
  const teams = teamsQuery.data?.teams ?? [];

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const connect = async () => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || operationRef.current || !configured) return;
    operationRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await backendRequest<{ authorizeUrl: string }>(`${endpoint}/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "vercel" }), signal });
      if (signal.aborted) return;
      const url = new URL(data.authorizeUrl);
      if (url.protocol !== "https:" && url.origin !== window.location.origin) throw new Error("Could not open the Vercel authorization page.");
      window.location.assign(url.href);
    } catch (err) {
      if (!signal.aborted) { setError(err instanceof Error ? err : new Error("Could not connect Vercel.")); setBusy(false); }
      operationRef.current = false;
    }
  };

  const postAction = async (action: "select_vercel_team" | "publish" | "unlink_vercel" | "reconcile_vercel_publish") => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || operationRef.current || busy || (publishing && action !== "reconcile_vercel_publish") || !connected) return;
    if (action === "select_vercel_team" && (projectBound || !teams.some(({ id }) => id === teamId))) return;
    if (action === "publish" && (!vercel?.teamId || (draftTeamId !== null && draftTeamId !== vercel.teamId))) return;
    operationRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await backendRequest<SessionIntegrationsProjection>(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "select_vercel_team" ? { action, teamId } : { action }), signal });
      if (signal.aborted) return;
      queryClient.setQueryData(backendQueryKey(sessionId), data);
      if (action === "select_vercel_team") { setDraftTeamId(null); setNotice("Vercel Team saved. You can now publish your app."); }
      else if (action === "unlink_vercel") {
        setDraftTeamId(null);
        void queryClient.invalidateQueries({ queryKey: ["session-backend-vercel"] });
        void queryClient.invalidateQueries({ queryKey: ["session-backend"] });
        setNotice("Vercel disconnected for your account.");
      } else setNotice(data.deploy.status === "live" ? "Your app is published on Vercel." : data.deploy.status === "error" ? null : "Publishing on Vercel has started.");
    } catch (err) {
      if (!signal.aborted) {
        setError(err instanceof Error ? err : new Error("Could not save this change."));
        // The server may have accepted the job before the response was interrupted.
        void queryClient.invalidateQueries({ queryKey: backendQueryKey(sessionId) });
      }
    } finally {
      operationRef.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  return <div className="mx-auto max-w-3xl space-y-5 px-4 py-5 @[600px]/backend:px-6">
    <div><h3 className="text-sm font-semibold">Publish to Vercel</h3><p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">Publish the latest saved version of your app to your Vercel Team.</p></div>
    {error ? <BackendError error={error} /> : null}
    {notice ? <p role="status" className="flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"><Check aria-hidden className="mt-0.5 size-3.5 shrink-0" />{notice}</p> : null}
    {publicUrl ? <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-medium">Production URL</p>
      <a href={publicUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex max-w-full items-center gap-1.5 text-xs text-blue-600 hover:underline dark:text-blue-400"><span className="break-all">{publicUrl}</span><ExternalLink aria-hidden className="size-3 shrink-0" /><span className="sr-only"> (opens in a new tab)</span></a>
      {deploy.status === "error" ? <p className="mt-2 text-xs leading-relaxed text-zinc-500">Your previous production version remains live while you resolve the latest publishing error.</p> : null}
    </div> : null}
    {legacyUrl ? <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"><p className="text-xs font-medium">Previous publication · Freestyle</p><a href={legacyUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex max-w-full items-center gap-1.5 text-xs text-blue-600 hover:underline dark:text-blue-400"><span className="break-all">{legacyUrl}</span><ExternalLink aria-hidden className="size-3 shrink-0" /><span className="sr-only"> (opens in a new tab)</span></a><p className="mt-2 text-xs leading-relaxed text-zinc-500">This is a read-only link to your previous publication. Future publications use Vercel.</p></div> : null}
    {!configured ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">Vercel connection setup is not available on this builder yet. Please try again later.</p> : null}
    <div className="space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-medium">Vercel account</p><span className={`rounded-full px-2 py-1 text-[10px] ${connected ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"}`}>{connected ? "Connected" : "Not connected"}</span></div>
      {!connected ? <><p className="text-xs leading-relaxed text-zinc-500">Connect Vercel to choose a Team and publish this app.{projectBound ? " Reconnect to continue using this app’s existing project." : ""}</p><button type="button" disabled={busy || !configured} onClick={() => void connect()} className={backendPrimaryButtonClass}>{busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <ExternalLink aria-hidden className="size-3.5" />}Connect Vercel</button></> : <>
        <div><p className="text-xs font-medium">Selected Team</p><p className="mt-1 break-all text-xs text-zinc-500">{vercel?.teamName ?? vercel?.teamId ?? "No Team selected"}</p></div>
        {!projectBound ? <div className="space-y-3">
          <label className="block"><span className="mb-2 block text-xs font-medium">Vercel Team</span><select value={teamId} onChange={(event) => setDraftTeamId(event.target.value)} disabled={locked || teamsQuery.isFetching || !teams.length} className={backendInputClass}><option value="">Select a Team</option>{vercel?.teamId && !teams.some(({ id }) => id === vercel.teamId) ? <option value={vercel.teamId}>{vercel.teamName ?? vercel.teamId}</option> : null}{teams.map(({ id, slug, name }) => <option key={id} value={id}>{name} ({slug})</option>)}</select></label>
          {teamsQuery.isFetching ? <p role="status" className="text-xs text-zinc-500">Loading Vercel Teams…</p> : teamsQuery.error ? <BackendError error={teamsQuery.error} onRetry={() => void teamsQuery.refetch()} /> : teamsQuery.isSuccess && !teams.length ? <p className="text-xs text-zinc-500">No Vercel Teams are available. Reconnect Vercel to check your access.</p> : null}
          <button type="button" disabled={locked || !teamId || teamId === vercel?.teamId || !teams.some(({ id }) => id === teamId)} onClick={() => void postAction("select_vercel_team")} className={backendButtonClass}>Save Team</button>
          <p className="text-[11px] leading-relaxed text-zinc-500">Choose and save a Team before publishing. The Team becomes fixed when this app’s Vercel project is created.</p>
        </div> : null}
        <button type="button" disabled={busy || !configured} onClick={() => void connect()} className={backendButtonClass}><RefreshCw aria-hidden className="size-3.5" />Reconnect Vercel</button><p className="text-[11px] leading-relaxed text-zinc-500">If your authorization has expired, reconnect to restore access to the existing project.</p>
      </>}
      {projectBound ? <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800"><p className="text-xs font-medium">{vercel?.projectName ?? "Vercel project"}</p><p className="mt-1 break-all font-mono text-[11px] text-zinc-500">{vercel?.projectId}</p>{!connected ? <p className="mt-2 break-all text-xs text-zinc-500">Team: {vercel?.teamName ?? vercel?.teamId ?? "Unavailable"}</p> : null}<p className="mt-2 text-[11px] leading-relaxed text-zinc-500">This app is bound to this project. Its Team cannot be changed.</p>{dashboardUrl ? <a href={dashboardUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline dark:text-blue-400">Open Vercel project<ExternalLink aria-hidden className="size-3" /><span className="sr-only"> (opens in a new tab)</span></a> : null}</div> : null}
    </div>
    {connected || projectBound || deploy.sourceSha || deploy.error || deploy.logs || publishing ? <div className="space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div role="status" className="flex items-center gap-2 text-xs font-medium">{publishing ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Rocket aria-hidden className="size-3.5" />}{publishing ? "Publishing…" : deploy.status === "error" ? "Latest publication failed" : deploy.status === "live" && !legacy ? "Published on Vercel" : "Ready to publish"}{phase ? <span className="font-normal text-zinc-500">· {phase}</span> : null}</div>
      {deploy.sourceSha ? <div><p className="text-[11px] text-zinc-500">Source revision</p><p className="mt-1 break-all font-mono text-xs" title={deploy.sourceSha}>{deploy.sourceSha}</p></div> : null}
      {deploy.error ? <BackendError error={new Error(deploy.error)} /> : deploy.status === "error" ? <BackendError error={new Error("Publishing failed. Review the logs and try again, or reconnect Vercel if your authorization has expired.")} /> : null}
      {connected && publishing ? <button type="button" disabled={busy} onClick={() => void postAction("reconcile_vercel_publish")} className={backendButtonClass}><RefreshCw aria-hidden className="size-3.5" />Check deployment status</button> : null}
      {deploy.logs ? <details open={deploy.status === "error"} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><summary className="cursor-pointer text-xs font-medium">Publishing logs</summary><pre tabIndex={0} aria-label="Publishing logs" className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-3 font-mono text-[11px] leading-relaxed dark:bg-zinc-900">{deploy.logs}</pre></details> : null}
      {connected ? <><button type="button" disabled={locked || !vercel?.teamId || (draftTeamId !== null && draftTeamId !== vercel.teamId)} onClick={() => void postAction("publish")} className={backendPrimaryButtonClass}>{publishing || busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Rocket aria-hidden className="size-3.5" />}{publishing ? "Publishing…" : "Publish to Vercel"}</button><p className="text-xs leading-relaxed text-zinc-500">Publish the latest saved version with your connected services. Check your app in preview before publishing.</p>{draftTeamId !== null && draftTeamId !== vercel?.teamId ? <p className="text-xs text-zinc-500">Save your Team selection before publishing.</p> : null}</> : null}
    </div> : null}
    {connected ? <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800"><p id="vercel-disconnect-help" className="mb-3 text-xs leading-relaxed text-zinc-500">Disconnecting Vercel removes your account’s authorization for all apps in this builder. You cannot disconnect while any of your apps are publishing. Reconnect to publish again using the existing project.</p><button type="button" disabled={locked} aria-describedby="vercel-disconnect-help" onClick={() => void postAction("unlink_vercel")} className={backendButtonClass}><Unlink aria-hidden className="size-3.5" />Disconnect Vercel for all apps</button></div> : null}
  </div>;
}
