"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, Copy, Filter, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { SupabaseDatabaseTable, SupabaseTableRowsFilter, SupabaseTableRowsRequest, SupabaseTableRowsResponse } from "@/lib/integrations/supabase-admin-types";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { BackendError, BackendLoading, backendButtonClass, backendInputClass, backendPrimaryButtonClass, backendRequest } from "./backend-ui";

interface BackendTableDataProps {
  sessionId: string;
  projectRef: string | null;
  table: SupabaseDatabaseTable;
  refreshKey: number;
  active: boolean;
  onBusyChange: (busy: boolean) => void;
}

type BrowseOptions = Omit<SupabaseTableRowsRequest, "schema" | "table"> & { offset: number; pageSize: number };
type CellSelection = { column: string; rowNumber: number; value: unknown };

const filterOperators = [
  { value: "contains", label: "Contains" },
  { value: "equals", label: "Equals" },
  { value: "not_equals", label: "Does not equal" },
  { value: "is_null", label: "Is empty (NULL)" },
  { value: "is_not_null", label: "Is not empty" },
] as const;

function cellText(value: unknown, formatted = false): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, formatted ? 2 : undefined) ?? "";
}

function CellDetails({ cell, table, onClose }: { cell: CellSelection; table: SupabaseDatabaseTable; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const value = cellText(cell.value, true);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] gap-3 sm:max-w-2xl">
        <DialogTitle className="pr-8 font-mono text-sm">{cell.column}</DialogTitle>
        <DialogDescription className="text-xs">{table.schema}.{table.name} · Row {cell.rowNumber}</DialogDescription>
        <pre className="max-h-[55vh] overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">{value === "" ? <span className="text-zinc-400">Empty string</span> : value}</pre>
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-[11px] text-zinc-500">{copyError ? "Could not copy. Select the value to copy it manually." : "Read-only value"}</p>
          <button type="button" className={backendButtonClass} onClick={async () => {
            try { await navigator.clipboard.writeText(value); setCopied(true); setCopyError(false); }
            catch { setCopyError(true); }
          }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy value"}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BackendTableData({ sessionId, projectRef, table, refreshKey, active, onBusyChange }: BackendTableDataProps) {
  const filterId = useId();
  const [options, setOptions] = useState<BrowseOptions>({ offset: 0, pageSize: 25 });
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterColumn, setFilterColumn] = useState(table.columns[0]?.name ?? "");
  const [filterOperator, setFilterOperator] = useState<SupabaseTableRowsFilter["operator"]>("contains");
  const [filterValue, setFilterValue] = useState("");
  const [cell, setCell] = useState<CellSelection | null>(null);
  const request: SupabaseTableRowsRequest = { schema: table.schema, table: table.name, ...options };
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ["session-backend-rows", sessionId, projectRef, request],
    queryFn: ({ signal }) => backendRequest<SupabaseTableRowsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/integrations/supabase/rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    }),
    enabled: active,
    staleTime: 15_000,
    gcTime: 0,
    refetchOnWindowFocus: active,
    retry: false,
  });

  useEffect(() => { if (refreshKey > 0 && active) void refetch(); }, [refreshKey, active, refetch]);
  useEffect(() => { onBusyChange(isFetching); return () => onBusyChange(false); }, [isFetching, onBusyChange]);

  const currentSort = options.sort ?? data?.orderBy[0];
  const filterNeedsValue = filterOperator !== "is_null" && filterOperator !== "is_not_null";
  const rows = data?.rows ?? [];
  const pageStart = rows.length ? options.offset + 1 : 0;
  const pageEnd = options.offset + rows.length;
  const filterLabel = options.filter ? `${options.filter.column} ${filterOperators.find(({ value }) => value === options.filter?.operator)?.label.toLowerCase()}${options.filter.value !== undefined ? ` “${options.filter.value}”` : ""}` : "";

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" aria-expanded={filterOpen} aria-controls={filterId} onClick={() => setFilterOpen((open) => !open)} className={`${backendButtonClass} ${options.filter ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400" : ""}`}><Filter className="size-3.5" />Filter{options.filter ? <span className="rounded bg-emerald-100 px-1 text-[10px] dark:bg-emerald-950">1</span> : null}</button>
          {options.filter ? <button type="button" onClick={() => { setOptions((current) => ({ ...current, offset: 0, filter: undefined })); setFilterValue(""); }} className="inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-white" title={filterLabel}><span className="max-w-44 truncate">{filterLabel}</span><X className="size-3 shrink-0" aria-label="Clear filter" /></button> : null}
        </div>
        <button type="button" onClick={() => void refetch()} disabled={isFetching} className={backendButtonClass} aria-label="Refresh table data"><RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} /><span className="hidden @[580px]/database:inline">Refresh</span></button>
      </div>

      {filterOpen ? (
        <form id={filterId} className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50" onSubmit={(event) => {
          event.preventDefault();
          const filter: SupabaseTableRowsFilter = filterOperator === "is_null" || filterOperator === "is_not_null"
            ? { column: filterColumn, operator: filterOperator }
            : { column: filterColumn, operator: filterOperator, value: filterValue };
          setOptions((current) => ({ ...current, offset: 0, filter }));
          setFilterOpen(false);
        }}>
          <label className="min-w-28 flex-1"><span className="mb-1.5 block text-[10px] text-zinc-500">Column</span><select aria-label="Filter column" value={filterColumn} onChange={(event) => setFilterColumn(event.target.value)} className={backendInputClass}>{table.columns.map(({ name }) => <option key={name} value={name}>{name}</option>)}</select></label>
          <label className="min-w-32 flex-1"><span className="mb-1.5 block text-[10px] text-zinc-500">Condition</span><select aria-label="Filter condition" value={filterOperator} onChange={(event) => setFilterOperator(event.target.value as SupabaseTableRowsFilter["operator"])} className={backendInputClass}>{filterOperators.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
          {filterNeedsValue ? <label className="min-w-28 flex-1"><span className="mb-1.5 block text-[10px] text-zinc-500">Value</span><input aria-label="Filter value" value={filterValue} onChange={(event) => setFilterValue(event.target.value)} maxLength={2000} placeholder="Enter a value…" className={backendInputClass} /></label> : null}
          <button type="submit" disabled={!filterColumn} className={backendPrimaryButtonClass}>Apply</button>
        </form>
      ) : null}

      {error ? <BackendError error={error} onRetry={() => void refetch()} /> : null}
      {isPending ? <BackendLoading>Loading table data…</BackendLoading> : data ? (
        <>
          <div className="relative max-h-[min(45dvh,24rem)] overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800" aria-busy={isFetching}>
            <table className="w-full border-separate border-spacing-0 text-left text-xs">
              <caption className="sr-only">Data in {table.schema}.{table.name}</caption>
              <thead className="sticky top-0 z-10 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th scope="col" className="border-b border-zinc-200 px-3 py-2 text-[10px] font-normal dark:border-zinc-800"><span className="sr-only">Row number</span>#</th>
                  {table.columns.map((column) => {
                    const sorted = currentSort?.column === column.name;
                    const SortIcon = sorted ? currentSort.direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
                    return <th key={column.name} scope="col" aria-sort={sorted ? currentSort.direction === "asc" ? "ascending" : "descending" : "none"} className="border-b border-zinc-200 px-1 py-1 text-[11px] font-medium dark:border-zinc-800"><button type="button" onClick={() => setOptions((current) => ({ ...current, offset: 0, sort: { column: column.name, direction: sorted && currentSort.direction === "asc" ? "desc" : "asc" } }))} className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-zinc-800" title={`Sort by ${column.name}`}><span><span className="block font-mono whitespace-nowrap text-zinc-700 dark:text-zinc-200">{column.name}</span><span className="mt-0.5 block max-w-44 truncate text-[9px] font-normal text-zinc-400">{column.dataType}</span></span><SortIcon className={`ml-auto size-3 shrink-0 ${sorted ? "text-emerald-600 dark:text-emerald-400" : "opacity-30 group-hover:opacity-100"}`} /></button></th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? <tr><td colSpan={table.columns.length + 1} className="px-5 py-14 text-center"><p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{options.filter ? "No rows match this filter" : options.offset > 0 ? "No rows on this page" : "This table has no data yet"}</p><p className="mt-1.5 text-[11px] text-zinc-400">{options.filter ? "Try another condition or clear the filter." : options.offset > 0 ? "Return to the previous page or refresh the table." : "New records will appear here when your app adds them."}</p></td></tr> : rows.map((row, rowIndex) => <tr key={rowIndex} className="group hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40">
                  <td className="border-b border-zinc-100 px-3 py-2.5 text-[10px] text-zinc-400 group-last:border-b-0 dark:border-zinc-800">{options.offset + rowIndex + 1}</td>
                  {table.columns.map((column) => {
                    const value = row[column.name];
                    const text = cellText(value);
                    return <td key={column.name} className="border-b border-l border-zinc-100 p-0 group-last:border-b-0 dark:border-zinc-800"><button type="button" onClick={() => setCell({ column: column.name, rowNumber: options.offset + rowIndex + 1, value })} aria-label={`View ${column.name}, row ${options.offset + rowIndex + 1}`} className="block w-full px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500/50"><span className={`block max-w-60 truncate font-mono text-[11px] ${value === null ? "italic text-zinc-400 dark:text-zinc-600" : typeof value === "boolean" ? "text-blue-600 dark:text-blue-400" : "text-zinc-700 dark:text-zinc-300"}`}>{text === "" ? <span className="text-zinc-300 dark:text-zinc-700">Empty string</span> : text}</span></button></td>;
                  })}
                </tr>)}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-[11px] text-zinc-500">{isFetching ? <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />Refreshing…</span> : rows.length ? `Rows ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()}` : "0 rows"}</p>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[10px] text-zinc-500"><span className="hidden @[580px]/database:inline">Rows per page</span><select aria-label="Rows per page" value={options.pageSize} onChange={(event) => setOptions((current) => ({ ...current, offset: 0, pageSize: Number(event.target.value) }))} className={`${backendInputClass} w-auto px-1.5 py-1`}>{[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
              <span className="mx-1 h-4 border-l border-zinc-200 dark:border-zinc-800" />
              <button type="button" aria-label="Previous data page" disabled={options.offset === 0 || isFetching} onClick={() => setOptions((current) => ({ ...current, offset: Math.max(0, current.offset - current.pageSize) }))} className={`${backendButtonClass} px-2 py-1.5`}><ChevronLeft className="size-3.5" /></button>
              <button type="button" aria-label="Next data page" disabled={!data.hasMore || isFetching || options.offset + options.pageSize > 100_000} onClick={() => setOptions((current) => ({ ...current, offset: current.offset + current.pageSize }))} className={`${backendButtonClass} px-2 py-1.5`}><ChevronRight className="size-3.5" /></button>
            </div>
          </div>
          <p className="text-[10px] leading-relaxed text-zinc-400">Read-only owner view · Click a column header to sort or a cell to view its full value.</p>
        </>
      ) : null}
      {cell ? <CellDetails key={`${cell.rowNumber}:${cell.column}`} cell={cell} table={table} onClose={() => setCell(null)} /> : null}
    </div>
  );
}
