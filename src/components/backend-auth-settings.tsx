"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, MailCheck, Save } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { SupabaseAuthPatch, SupabaseAuthResponse, SupabaseAuthSettings } from "@/lib/integrations/supabase-admin-types";

import { BackendError, BackendLoading, backendButtonClass, backendInputClass, backendPrimaryButtonClass, backendRequest } from "./backend-ui";

interface BackendAuthSettingsProps {
  sessionId: string;
  projectRef: string | null;
  refreshKey: number;
  active: boolean;
  onBusyChange?: (busy: boolean) => void;
}

function SettingToggle({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return <div className="flex items-start justify-between gap-5 px-4 py-5">
    <div><label htmlFor={id} className="cursor-pointer text-xs font-medium">{label}</label><p id={`${id}-description`} className="mt-1 max-w-md text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p></div>
    <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={`${id}-description`} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-2 disabled:opacity-50 ${checked ? "bg-emerald-600" : "bg-zinc-200 dark:bg-zinc-700"}`}><span className={`size-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`} /></button>
  </div>;
}

type Draft = { base: SupabaseAuthSettings; settings: SupabaseAuthSettings; redirectText: string };

export function BackendAuthSettings({ sessionId, projectRef, refreshKey, active, onBusyChange }: BackendAuthSettingsProps) {
  const queryClient = useQueryClient();
  const queryKey = ["session-backend-auth", sessionId, projectRef];
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/integrations/supabase/auth`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: ({ signal }) => backendRequest<SupabaseAuthResponse>(endpoint, { signal }),
    staleTime: 30_000,
    enabled: active,
    refetchOnWindowFocus: active,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (patch: SupabaseAuthPatch) => backendRequest<SupabaseAuthResponse>(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
      setDraft(null);
      setSaved(true);
    },
  });

  useEffect(() => { if (refreshKey > 0 && active) void refetch(); }, [refreshKey, active, refetch]);
  useEffect(() => { onBusyChange?.(isFetching || mutation.isPending); return () => onBusyChange?.(false); }, [isFetching, mutation.isPending, onBusyChange]);

  if (isPending) return <BackendLoading>Loading authentication settings…</BackendLoading>;
  if (error) return <div className="p-4"><BackendError error={error} onRetry={() => void refetch()} /></div>;
  if (!data) return null;

  const settings = draft?.settings ?? data.settings;
  const base = draft?.base ?? data.settings;
  const redirectText = draft?.redirectText ?? settings.redirectUrls.join("\n");
  const patch: SupabaseAuthPatch = {};
  for (const key of ["emailConfirmationRequired", "signupEnabled", "anonymousSignInsEnabled", "siteUrl", "redirectUrls"] as const) {
    if (JSON.stringify(settings[key]) !== JSON.stringify(base[key])) Object.assign(patch, { [key]: settings[key] });
  }
  const dirty = Object.keys(patch).length > 0;
  const update = (changes: Partial<SupabaseAuthSettings>, text = redirectText) => {
    setSaved(false);
    mutation.reset();
    setDraft({ base, settings: { ...settings, ...changes }, redirectText: text });
  };

  return <form onSubmit={(event) => { event.preventDefault(); if (dirty && !mutation.isPending) mutation.mutate(patch); }} className="mx-auto max-w-3xl py-5">
    {mutation.error ? <div className="mb-4"><BackendError error={mutation.error} /></div> : null}
    <div className="mb-3 flex items-center gap-2"><MailCheck className="size-3.5 text-zinc-400" /><h4 className="text-xs font-medium">Sign-in & registration</h4></div>
    <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      <SettingToggle label="Require email verification" description="Send a confirmation email at signup. New users must verify their email address before signing in." checked={settings.emailConfirmationRequired} disabled={mutation.isPending} onChange={(emailConfirmationRequired) => update({ emailConfirmationRequired })} />
      <SettingToggle label="Allow new signups" description="Let new users create an account. Existing users can still sign in when this is turned off." checked={settings.signupEnabled} disabled={mutation.isPending} onChange={(signupEnabled) => update({ signupEnabled })} />
      <SettingToggle label="Allow anonymous sign-ins" description="Let visitors use your app with a temporary anonymous account, without an email address or password." checked={settings.anonymousSignInsEnabled} disabled={mutation.isPending} onChange={(anonymousSignInsEnabled) => update({ anonymousSignInsEnabled })} />
    </div>
    <div className="mt-7"><h4 className="text-xs font-medium">URL configuration</h4><p className="mt-1 text-[11px] leading-relaxed text-zinc-500">Control where users return after email verification and sign-in.</p>
      <div className="mt-3 space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <label className="block"><span className="mb-2 block text-xs font-medium">Site URL</span><input aria-label="Authentication site URL" type="url" required value={settings.siteUrl} disabled={mutation.isPending} onChange={(event) => update({ siteUrl: event.target.value })} placeholder="https://your-app.com" className={backendInputClass} /><span className="mt-1.5 block text-[11px] text-zinc-500">The default destination for authentication redirects.</span></label>
        <label className="block"><span className="mb-2 block text-xs font-medium">Allowed redirect URLs</span><textarea aria-label="Allowed authentication redirect URLs" value={redirectText} disabled={mutation.isPending} onChange={(event) => update({ redirectUrls: event.target.value.split("\n").map((url) => url.trim()).filter(Boolean) }, event.target.value)} rows={4} spellCheck={false} placeholder={"https://your-app.com/auth/callback\nhttp://localhost:3000/**"} className={`${backendInputClass} resize-y font-mono leading-relaxed`} /><span className="mt-1.5 block text-[11px] text-zinc-500">One URL per line. Include the preview URL when testing sign-in.</span></label>
      </div>
    </div>
    <div className="sticky bottom-0 -mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 bg-white/95 px-4 py-4 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95">
      <p role="status" className={`flex items-center gap-1.5 text-[11px] ${saved ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}`}>{saved ? <><Check className="size-3.5" />Settings saved</> : dirty ? "You have unsaved changes" : "Changes apply to your connected Supabase project."}</p>
      <div className="flex gap-2">{dirty ? <button type="button" disabled={mutation.isPending} onClick={() => { setDraft(null); mutation.reset(); }} className={backendButtonClass}>Discard</button> : null}<button type="submit" disabled={!dirty || mutation.isPending} className={backendPrimaryButtonClass}>{mutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}{mutation.isPending ? "Saving…" : "Save changes"}</button></div>
    </div>
  </form>;
}
