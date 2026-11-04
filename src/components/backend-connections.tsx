"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Link2, Loader2, RefreshCw, Unlink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionIntegrationsProjection } from "@/lib/integrations/types";

import { BackendError, backendButtonClass, backendInputClass, backendPrimaryButtonClass, backendQueryKey, backendRequest } from "./backend-ui";

type ConnectionSection = "connections" | "stripe";
interface ProjectOption { ref: string; name: string }
interface OrganizationOption { slug: string; name: string }
type IntegrationResult = SessionIntegrationsProjection & { preview?: { status: "pending" | "ready" | "error"; error: string | null } };

export function BackendConnections({ sessionId, status, section }: { sessionId: string; status: SessionIntegrationsProjection; section: ConnectionSection }) {
  const queryClient = useQueryClient();
  const controllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [projectRef, setProjectRef] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualAnon, setManualAnon] = useState("");
  const [manualService, setManualService] = useState("");
  const [stripePk, setStripePk] = useState("");
  const [stripeSk, setStripeSk] = useState("");
  const [stripeWh, setStripeWh] = useState("");
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/integrations`;
  const canEdit = status.secretsConfigured && !busy;
  const supabaseLinked = status.supabase.status === "linked";
  const stripeLinked = status.stripe.status === "linked";

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => controller.abort();
  }, []);

  const loadProjects = useCallback(async () => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const [projectResult, orgResult] = await Promise.all([
        backendRequest<{ projects: ProjectOption[] }>(`${endpoint}/supabase/projects`, { signal }),
        backendRequest<{ organizations: OrganizationOption[] }>(`${endpoint}/supabase/projects?organizations`, { signal }),
      ]);
      if (signal.aborted) return;
      setProjects(projectResult.projects);
      setProjectRef((current) => projectResult.projects.some(({ ref }) => ref === current) ? current : projectResult.projects[0]?.ref ?? "");
      setOrganizations(orgResult.organizations);
      setOrganizationSlug((current) => orgResult.organizations.some(({ slug }) => slug === current) ? current : orgResult.organizations.length === 1 ? orgResult.organizations[0].slug : "");
    } catch (err) {
      if (!signal.aborted) { setProjects([]); setError(err instanceof Error ? err : new Error("Could not load Supabase projects.")); }
    } finally {
      operationRef.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (section === "connections" && status.supabaseAccountConnected && !supabaseLinked && projects === null) queueMicrotask(() => void loadProjects());
  }, [section, status.supabaseAccountConnected, supabaseLinked, projects, loadProjects]);

  const connectAccount = async (provider: "supabase" | "stripe") => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const data = await backendRequest<{ authorizeUrl: string }>(`${endpoint}/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }), signal });
      if (signal.aborted) return;
      const url = new URL(data.authorizeUrl);
      if (url.protocol !== "https:" && url.origin !== window.location.origin) throw new Error("Could not open the account authorization page.");
      window.location.assign(url.href);
    } catch (err) {
      if (!signal.aborted) { setError(err instanceof Error ? err : new Error("Could not start the account connection.")); setBusy(false); }
      operationRef.current = false;
    }
  };

  const postAction = async (body: Record<string, unknown>) => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const send = () => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      let response = await send();
      for (let attempt = 0; response.status === 202 && body.action === "provision_supabase" && attempt < 24; attempt++) {
        setNotice("Supabase is preparing your project. It will connect when ready.");
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, 5_000);
          signal.addEventListener("abort", finish, { once: true });
          if (signal.aborted) finish();
        });
        if (signal.aborted) return;
        response = await send();
      }
      if (response.status === 202 && body.action === "provision_supabase") { setNotice("Project setup is still pending. Select the same organization and resume setup to check its status."); return; }
      const data = await response.json() as IntegrationResult & { error?: string };
      if (signal.aborted) return;
      if (!response.ok || !data.supabase || !data.stripe || !data.deploy) throw new Error(data.error ?? "Could not save this change. Please try again.");
      queryClient.setQueryData(backendQueryKey(sessionId), data);
      // A relink may point at a different project, including after credential changes.
      void queryClient.invalidateQueries({ queryKey: ["session-backend-auth", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["session-backend-schema", sessionId] });
      setManualUrl(""); setManualAnon(""); setManualService("");
      setStripePk(""); setStripeSk(""); setStripeWh("");
      if (data.preview?.status === "error") setError(new Error("Saved, but the preview could not refresh. Please try again shortly."));
      else setNotice(data.preview?.status === "ready" ? "Saved. Your preview settings are up to date." : "Saved. Preview settings are being refreshed.");
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err : new Error("Could not save this change."));
    } finally {
      operationRef.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  const title = section === "connections" ? "Connections" : "Payments";
  const description = section === "connections" ? "Connect a Supabase project to power your app." : "Connect Stripe to accept payments in your app.";
  const manualRef = manualUrl.trim().match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i)?.[1];

  return <div className="mx-auto max-w-3xl space-y-5 px-4 py-5 @[600px]/backend:px-6">
    <div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p></div>
    {error ? <BackendError error={error} /> : null}
    {notice ? <p role="status" className="flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"><Check className="mt-0.5 size-3.5 shrink-0" />{notice}</p> : null}
    {!status.secretsConfigured ? <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">Connections are not available on this builder yet. Please try again later.</p> : null}
    {busy ? <p role="status" className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="size-3.5 animate-spin" />Updating connection…</p> : null}
    <fieldset disabled={!canEdit} aria-busy={busy} className="min-w-0 space-y-5">
      {section === "connections" ? <>
        {supabaseLinked ? <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium break-all">{status.supabase.projectName ?? "Supabase project"}</p><p className="mt-1 text-[11px] break-all text-zinc-500">{status.supabase.projectUrl}</p></div><span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">Connected</span></div>
          <p className="mt-4 text-xs leading-relaxed text-zinc-500">Your app uses this project for its database and authentication.</p>
          {status.supabase.linkMethod === "manual" ? <p className="mt-2 text-xs leading-relaxed text-zinc-500">To manage authentication and view the database here, reconnect using your Supabase account.</p> : null}
          <button type="button" onClick={() => void postAction({ action: "unlink_supabase" })} className="mt-4 inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-600"><Unlink className="size-3.5" />Unlink project</button>
        </div> : <>
          {status.supabaseOauthConfigured ? status.supabaseAccountConnected ? <>
            {organizations.length ? <div className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"><label className="block"><span className="mb-2 block text-xs font-medium">Create a dedicated project</span><select aria-label="Supabase organization" value={organizationSlug} onChange={(event) => setOrganizationSlug(event.target.value)} className={backendInputClass}><option value="">Select an organization</option>{organizations.map(({ slug, name }) => <option key={slug} value={slug}>{name}</option>)}</select></label><p className="text-[11px] leading-relaxed text-zinc-500">Created in East US (North Virginia). Your organization’s project limits and billing apply.</p><button type="button" disabled={!canEdit || !organizationSlug} onClick={() => void postAction({ action: "provision_supabase", organizationSlug })} className={backendPrimaryButtonClass}>Create or resume project setup</button></div> : null}
            <div className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"><label className="block"><span className="mb-2 block text-xs font-medium">Use an existing project</span><select aria-label="Supabase project" value={projectRef} disabled={busy || !projects?.length} onChange={(event) => setProjectRef(event.target.value)} className={backendInputClass}><option value="">Select a project</option>{(projects ?? []).map(({ ref, name }) => <option key={ref} value={ref}>{name} ({ref})</option>)}</select></label>{projects?.length === 0 ? <p className="text-[11px] text-zinc-500">No projects loaded. Create a project in Supabase or reload the list.</p> : null}<div className="flex flex-wrap gap-2"><button type="button" disabled={!projectRef || !canEdit} onClick={() => void postAction({ action: "link_supabase_connect", projectRef })} className={backendPrimaryButtonClass}><Link2 className="size-3.5" />Link project</button><button type="button" onClick={() => void loadProjects()} className={backendButtonClass}><RefreshCw className="size-3.5" />Reload projects</button></div></div>
          </> : <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"><p className="mb-4 text-xs leading-relaxed text-zinc-500">Connect your account to select a project or create a new one for this app.</p><button type="button" onClick={() => void connectAccount("supabase")} className={backendPrimaryButtonClass}>Connect Supabase account<ExternalLink className="size-3.5" /></button></div> : <p className="text-xs text-zinc-500">Account authorization is not available yet. You can connect with project keys below.</p>}
          <details className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"><summary className="cursor-pointer text-xs font-medium">Advanced: connect with project keys</summary><div className="mt-4 space-y-3"><a href={`https://supabase.com/dashboard/project/${manualRef ?? "_"}/settings/api-keys`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">Open Supabase API keys<ExternalLink className="size-3" /></a><input aria-label="Supabase project URL" type="url" value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} placeholder="https://xxxx.supabase.co" className={backendInputClass} /><input aria-label="Supabase anon or publishable key" type="password" autoComplete="off" value={manualAnon} onChange={(event) => setManualAnon(event.target.value)} placeholder="Anon / publishable key" className={backendInputClass} /><input aria-label="Supabase service role or secret key" type="password" autoComplete="off" value={manualService} onChange={(event) => setManualService(event.target.value)} placeholder="Service role / secret key" className={backendInputClass} /><button type="button" disabled={!canEdit || !manualUrl.trim() || !manualAnon.trim() || !manualService.trim()} onClick={() => void postAction({ action: "link_supabase_manual", projectUrl: manualUrl, anonKey: manualAnon, serviceRoleKey: manualService })} className={backendButtonClass}>Link with keys</button></div></details>
        </>}
        {status.supabase.status === "error" ? <p role="alert" className="text-xs text-red-600">The Supabase connection needs attention. Try connecting again.</p> : null}
      </> : null}
      {section === "stripe" ? <>
        {stripeLinked ? <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"><p className="text-xs font-medium">Stripe connected<span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] capitalize dark:bg-zinc-800">{status.stripe.mode} mode</span></p><p className="mt-2 font-mono text-xs text-zinc-500">{status.stripe.publishableKeyHint}</p><button type="button" onClick={() => void postAction({ action: "unlink_stripe" })} className="mt-4 inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-600"><Unlink className="size-3.5" />Unlink Stripe</button></div> : <>
          {status.connect?.stripe ? <button type="button" onClick={() => void connectAccount("stripe")} className={backendPrimaryButtonClass}>Connect Stripe<ExternalLink className="size-3.5" /></button> : <p className="text-xs text-zinc-500">Managed Stripe connection is awaiting setup. Use Advanced to connect test keys.</p>}
          <details className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"><summary className="cursor-pointer text-xs font-medium">Advanced: connect with Stripe keys</summary><div className="mt-4 space-y-3"><p className="text-[11px] text-zinc-500">Use test mode while building your app.</p><a href="https://dashboard.stripe.com/test/apikeys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">Open Stripe test API keys<ExternalLink className="size-3" /></a><input aria-label="Stripe publishable key" autoComplete="off" value={stripePk} onChange={(event) => setStripePk(event.target.value)} placeholder="pk_test_…" className={backendInputClass} /><input aria-label="Stripe secret key" autoComplete="off" type="password" value={stripeSk} onChange={(event) => setStripeSk(event.target.value)} placeholder="sk_test_…" className={backendInputClass} /><input aria-label="Stripe webhook signing secret (optional)" autoComplete="off" type="password" value={stripeWh} onChange={(event) => setStripeWh(event.target.value)} placeholder="whsec_… (optional)" className={backendInputClass} /><button type="button" disabled={!canEdit || !stripePk.trim() || !stripeSk.trim()} onClick={() => void postAction({ action: "link_stripe", publishableKey: stripePk, secretKey: stripeSk, webhookSecret: stripeWh || undefined })} className={backendPrimaryButtonClass}>Connect Stripe</button><a href="https://dashboard.stripe.com/test/webhooks" target="_blank" rel="noreferrer" className="block text-xs text-blue-600 hover:underline">Open Stripe test webhook settings</a></div></details>
        </>}
        {status.stripe.status === "error" ? <p role="alert" className="text-xs text-red-600">The Stripe connection needs attention. Try connecting again.</p> : null}
        <p className="text-xs leading-relaxed text-zinc-500">Ask the builder to add checkout and payment confirmation, then verify a test payment.</p>
      </> : null}
      {supabaseLinked || stripeLinked ? <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800"><button type="button" onClick={() => void postAction({ action: "refresh_connections" })} className={backendButtonClass}><RefreshCw className="size-3.5" />Refresh preview connections</button><p className="mt-2 text-[11px] leading-relaxed text-zinc-500">After changing account keys, refresh the preview and publish again to update your live app.</p></div> : null}
    </fieldset>
  </div>;
}
