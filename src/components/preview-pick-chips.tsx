"use client";

import { MousePointer2, XIcon } from "lucide-react";

import type { PreviewElementPickPayload } from "@/lib/preview/bridge-protocol";
import {
  previewPickChipLabel,
  previewPickChipTitle,
  type PreviewElementPick,
} from "@/lib/preview/format-preview-pick";
import { cn } from "@/lib/utils";

function PickChip({
  pick,
  onRemove,
}: {
  pick: PreviewElementPickPayload & { id?: string };
  onRemove?: (id: string) => void;
}) {
  const label = previewPickChipLabel(pick);
  const removable = Boolean(onRemove && pick.id);

  return (
    <div
      className={cn(
        "group relative flex max-w-56 items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 dark:border-blue-900 dark:bg-blue-950/50",
        removable ? "pr-1" : null,
      )}
      title={previewPickChipTitle(pick)}
    >
      <MousePointer2
        className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
        strokeWidth={2}
      />
      <span className="min-w-0 truncate font-medium text-xs text-zinc-800 dark:text-zinc-100">
        {label}
      </span>
      {removable ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-blue-100 hover:text-zinc-800 dark:hover:bg-blue-900 dark:hover:text-zinc-100"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove?.(pick.id!);
          }}
        >
          <XIcon className="size-3" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

/** Composer chips (removable). */
export function PreviewPickChips({
  picks,
  onRemove,
  className,
}: {
  picks: PreviewElementPick[];
  onRemove: (id: string) => void;
  className?: string;
}) {
  if (picks.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("flex w-full flex-wrap gap-2 px-2.5 pt-2", className)}
      data-slot="preview-pick-chips"
    >
      {picks.map((pick) => (
        <PickChip key={pick.id} pick={pick} onRemove={onRemove} />
      ))}
    </div>
  );
}

/** History chips inside a sent user message (read-only). */
export function UserMessagePreviewPickChips({
  picks,
  className,
}: {
  picks: Array<PreviewElementPickPayload & { id?: string }>;
  className?: string;
}) {
  if (picks.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("flex w-full flex-wrap gap-2", className)}
      data-slot="user-message-preview-picks"
    >
      {picks.map((pick, index) => (
        <PickChip key={pick.id ?? `${pick.selector}-${index}`} pick={pick} />
      ))}
    </div>
  );
}
