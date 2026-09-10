"use client";

import { MousePointer2, XIcon } from "lucide-react";

import {
  previewPickChipLabel,
  type PreviewElementPick,
} from "@/lib/preview/format-preview-pick";
import { cn } from "@/lib/utils";

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
      {picks.map((pick) => {
        const label = previewPickChipLabel(pick);
        return (
          <div
            key={pick.id}
            className="group relative flex max-w-56 items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 dark:border-blue-900 dark:bg-blue-950/50"
            title={`${pick.tagName} · ${pick.selector} · ${pick.path}`}
          >
            <MousePointer2
              className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
              strokeWidth={2}
            />
            <span className="min-w-0 truncate text-xs text-zinc-800 dark:text-zinc-100">
              {label}
            </span>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-blue-100 hover:text-zinc-800 dark:hover:bg-blue-900 dark:hover:text-zinc-100"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(pick.id);
              }}
            >
              <XIcon className="size-3" strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
