"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, KeyRound, Link2, Search, ShieldCheck, ShieldOff, Table2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { SupabaseDatabaseTable, SupabaseSchemaResponse } from "@/lib/integrations/supabase-admin-types";

import { BackendTableData } from "./backend-table-data";
import { BackendEmpty, BackendError, BackendLoading, backendInputClass, backendRequest } from "./backend-ui";

interface BackendDatabasePanelProps {
  sessionId: string;
  projectRef: string | null;
  refreshKey: number;
  active: boolean;
  onBusyChange?: (busy: boolean) => void;
}

function tableKey(table: SupabaseDatabaseTable) {
  return JSON.stringify([table.schema, table.name]);
}

export function BackendDatabasePanel({ sessionId, projectRef, refreshKey, active, onBusyChange }: BackendDatabasePanelProps) {
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [rowsBusy, setRowsBusy] = useState(false);
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ["session-backend-schema", sessionId, projectRef],
    queryFn: ({ signal }) => backendRequest<SupabaseSchemaResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/integrations/supabase/schema`, { signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: active,
    retry: false,
  });

  useEffect(() => { if (refreshKey > 0) void refetch(); }, [refreshKey, refetch]);
  useEffect(() => {
    onBusyChange?.(isFetching || rowsBusy);
    return () => onBusyChange?.(false);
  }, [isFetching, rowsBusy, onBusyChange]);

  const tables = data?.tables ?? [];
  const filtered = tables.filter((table) => `${table.schema}.${table.name}`.toLowerCase().includes(search.toLowerCase()));
  const selected = filtered.find((table) => tableKey(table) === selectedKey) ?? filtered[0];

  return (
    <div className="@container/database flex min-h-full flex-col">
      <div className="border-b border-zinc-100 px-4 py-5 dark:border-zinc-800 @[500px]/database:px-6">
        <h3 className="text-sm font-semibold">Database</h3>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">Browse your app’s data and explore its table structure.</p>
      </div>
      {isPending ? <BackendLoading>Loading database schema…</BackendLoading> : error ? <div className="p-4"><BackendError error={error} onRetry={() => void refetch()} /></div> : tables.length === 0 ? (
        <BackendEmpty title="Your database is ready for its first table">Ask the builder to add the data your app needs. Tables will appear here once created.</BackendEmpty>
      ) : (
        <div className="flex flex-1 flex-col @[580px]/database:flex-row">
          <div className="shrink-0 border-b border-zinc-200 p-3 dark:border-zinc-800 @[580px]/database:w-44 @[580px]/database:border-r @[580px]/database:border-b-0">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-zinc-400" />
              <input aria-label="Search database tables" type="search" placeholder="Search tables…" value={search} onChange={(event) => setSearch(event.target.value)} className={`${backendInputClass} pl-8`} />
            </div>
            <p className="mt-4 mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-zinc-400">Tables <span className="ml-1 font-mono">{tables.length}</span></p>
            <nav aria-label="Database tables" className="flex max-h-40 gap-1 overflow-auto @[580px]/database:max-h-none @[580px]/database:flex-col">
              {filtered.map((table) => {
                const key = tableKey(table);
                const current = selected === table;
                return (
                  <button key={key} type="button" aria-current={current ? "true" : undefined} onClick={() => setSelectedKey(key)} className={`flex min-w-0 shrink-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${current ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}>
                    <Table2 className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate" title={`${table.schema}.${table.name}`}>{table.schema !== "public" ? `${table.schema}.` : ""}{table.name}</span>
                    {current ? <ChevronRight className="ml-auto hidden size-3 shrink-0 @[580px]/database:block" /> : null}
                  </button>
                );
              })}
              {filtered.length === 0 ? <p className="px-1 py-2 text-xs text-zinc-500">No matching tables.</p> : null}
            </nav>
          </div>
          <div className="min-w-0 flex-1 p-4 @[500px]/database:p-5">
            {selected ? <DatabaseTable key={tableKey(selected)} table={selected} sessionId={sessionId} projectRef={projectRef} refreshKey={refreshKey} active={active} onBusyChange={setRowsBusy} /> : <BackendEmpty title="No tables match your search">Try another table name or schema.</BackendEmpty>}
          </div>
        </div>
      )}
    </div>
  );
}

function DatabaseTable({ table, ...props }: Omit<BackendDatabasePanelProps, "onBusyChange"> & { table: SupabaseDatabaseTable; onBusyChange: (busy: boolean) => void }) {
  const [view, setView] = useState<"data" | "structure">("data");
  const id = useId();

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] text-zinc-500">{table.schema}</p>
          <h4 className="mt-1 flex items-center gap-2 font-mono text-sm font-semibold"><Table2 className="size-4 text-zinc-400" strokeWidth={1.5} />{table.name}</h4>
          <p className="mt-2 text-[11px] text-zinc-500">{table.columns.length} {table.columns.length === 1 ? "column" : "columns"}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium ${table.rlsEnabled ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400" : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400"}`}>
          {table.rlsEnabled ? <ShieldCheck className="size-3" /> : <ShieldOff className="size-3" />}{table.rlsEnabled ? "RLS enabled" : "RLS disabled"}
        </span>
      </div>
      <div role="tablist" aria-label="Table view" className="mt-5 flex gap-4 border-b border-zinc-200 dark:border-zinc-800">
        {(["data", "structure"] as const).map((entry) => <button key={entry} id={`${id}-${entry}`} type="button" role="tab" aria-selected={view === entry} aria-controls={`${id}-panel-${entry}`} onClick={() => setView(entry)} className={`-mb-px border-b-2 px-0.5 pb-2.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${view === entry ? "border-zinc-900 text-zinc-900 dark:border-white dark:text-white" : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}>{entry === "data" ? "Data" : "Structure"}</button>)}
      </div>
      <div role="tabpanel" id={`${id}-panel-data`} aria-labelledby={`${id}-data`} hidden={view !== "data"}>
        <BackendTableData table={table} {...props} active={props.active && view === "data"} />
      </div>
      <div role="tabpanel" id={`${id}-panel-structure`} aria-labelledby={`${id}-structure`} hidden={view !== "structure"}>
        {view === "structure" ? <TableStructure table={table} /> : null}
      </div>
    </>
  );
}

function TableStructure({ table }: { table: SupabaseDatabaseTable }) {
  return (
    <>
      <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Columns in {table.schema}.{table.name}</caption>
          <thead className="border-b border-zinc-200 bg-zinc-50 text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900"><tr><th className="px-3 py-2.5 font-medium">Column</th><th className="px-3 py-2.5 font-medium">Type</th><th className="px-3 py-2.5 font-medium">Nullable</th><th className="px-3 py-2.5 font-medium">Default</th></tr></thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {table.columns.map((column) => (
              <tr key={column.name} className="align-top hover:bg-zinc-50/60 dark:hover:bg-zinc-900/40">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    <span className="break-all">{column.name}</span>
                    {column.primaryKey ? <span title="Primary key"><KeyRound aria-label="Primary key" className="size-3 shrink-0 text-amber-500" /></span> : null}
                    {column.references ? <span title={`References ${column.references.schema}.${column.references.table}.${column.references.column}`}><Link2 aria-label="Foreign key" className="size-3 shrink-0 text-blue-500" /></span> : null}
                  </div>
                  {column.references ? <p className="mt-1.5 max-w-48 break-all font-mono text-[10px] text-zinc-400">→ {column.references.schema}.{column.references.table}.{column.references.column}</p> : null}
                </td>
                <td className="px-3 py-3"><span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{column.dataType}</span></td>
                <td className="px-3 py-3 text-[11px] text-zinc-500">{column.nullable ? "Yes" : "No"}</td>
                <td className="max-w-48 px-3 py-3 font-mono text-[10px] break-all text-zinc-500">{column.defaultValue ?? <span className="text-zinc-300 dark:text-zinc-700">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-[10px] text-zinc-400"><KeyRound className="size-3 text-amber-500" />Primary key<span className="mx-1">·</span><Link2 className="size-3 text-blue-500" />Foreign key<span className="mx-1">·</span>Read-only schema</p>
    </>
  );
}
