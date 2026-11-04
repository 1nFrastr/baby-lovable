"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { BackendAuthSettings } from "./backend-auth-settings";
import { BackendAuthUsers } from "./backend-auth-users";

interface BackendAuthenticationProps {
  sessionId: string;
  projectRef: string | null;
  refreshKey: number;
  active: boolean;
  onBusyChange?: (busy: boolean) => void;
}

export function BackendAuthentication({ onBusyChange, ...props }: BackendAuthenticationProps) {
  const id = useId();
  const [tab, setTab] = useState<"users" | "settings">("users");
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [usersBusy, setUsersBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);

  useEffect(() => {
    onBusyChange?.(usersBusy || settingsBusy);
    return () => onBusyChange?.(false);
  }, [usersBusy, settingsBusy, onBusyChange]);

  const selectTab = (value: "users" | "settings") => {
    if (value === "settings") setSettingsMounted(true);
    setTab(value);
  };

  return (
    <div className="px-4 py-5 @[600px]/backend:px-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-zinc-400" strokeWidth={1.75} />Authentication</h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">View your app’s users and manage how they sign in.</p>
      <div role="tablist" aria-label="Authentication view" className="mt-5 flex gap-4 border-b border-zinc-200 dark:border-zinc-800">
        {(["users", "settings"] as const).map((value) => (
          <button key={value} id={`${id}-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`${id}-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => selectTab(value)} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "users" : event.key === "End" ? "settings" : value === "users" ? "settings" : "users";
            selectTab(next);
            document.getElementById(`${id}-${next}`)?.focus();
          }} className={`-mb-px border-b-2 px-0.5 pb-2.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${tab === value ? "border-zinc-900 text-zinc-900 dark:border-white dark:text-white" : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}>{value === "users" ? "Users" : "Settings"}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel-users`} aria-labelledby={`${id}-users`} hidden={tab !== "users"}>
        <BackendAuthUsers {...props} active={props.active && tab === "users"} onBusyChange={setUsersBusy} />
      </div>
      <div role="tabpanel" id={`${id}-panel-settings`} aria-labelledby={`${id}-settings`} hidden={tab !== "settings"}>
        {settingsMounted ? <BackendAuthSettings {...props} active={props.active && tab === "settings"} onBusyChange={setSettingsBusy} /> : null}
      </div>
    </div>
  );
}
