"use client";

import { Pencil, Paperclip, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { UserMessagePreviewPickChips } from "@/components/preview-pick-chips";
import type { QueuedChatMessage } from "@/lib/chat/message-queue";
import { cn } from "@/lib/utils";

function QueueItem({
  item,
  onRemove,
  onUpdateText,
}: {
  item: QueuedChatMessage;
  onRemove: (id: string) => void;
  onUpdateText: (id: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const node = inputRef.current;
    if (!node) {
      return;
    }
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [editing]);

  const fileCount = item.files.length;
  const preview =
    item.text.trim() ||
    (fileCount > 0
      ? item.files.map((file) => file.filename ?? "Attachment").join(", ")
      : item.picks.length > 0
        ? "Selected in preview"
        : "");

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next === item.text.trim()) {
      setDraft(item.text);
      return;
    }
    onUpdateText(item.id, draft);
  };

  return (
    <li className="group rounded-lg border border-zinc-200 bg-zinc-50/90 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/80">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <textarea
              ref={inputRef}
              aria-label="Edit queued message"
              className="field-sizing-content max-h-28 min-h-8 w-full resize-none bg-transparent text-sm text-zinc-900 outline-none dark:text-zinc-100"
              onBlur={commit}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(item.text);
                  setEditing(false);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  commit();
                }
              }}
              rows={1}
              value={draft}
            />
          ) : (
            <p className="truncate text-sm text-zinc-800 dark:text-zinc-100">
              {preview}
            </p>
          )}
          {item.picks.length > 0 ? (
            <UserMessagePreviewPickChips
              className="mt-1.5"
              picks={item.picks}
            />
          ) : null}
          {fileCount > 0 ? (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              <Paperclip className="size-3 shrink-0" />
              {fileCount === 1
                ? (item.files[0]?.filename ?? "1 file")
                : `${fileCount} files`}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
          <button
            aria-label="Edit queued message"
            className="flex size-6 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            onClick={() => {
              setDraft(item.text);
              setEditing(true);
            }}
            type="button"
          >
            <Pencil className="size-3" />
          </button>
          <button
            aria-label="Remove queued message"
            className="flex size-6 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            onClick={() => onRemove(item.id)}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      </div>
    </li>
  );
}

export function ChatMessageQueue({
  items,
  onRemove,
  onUpdateText,
  className,
}: {
  items: QueuedChatMessage[];
  onRemove: (id: string) => void;
  onUpdateText: (id: string, text: string) => void;
  className?: string;
}) {
  if (items.length === 0) {
    return null;
  }

  const countLabel =
    items.length === 1 ? "1 queued" : `${items.length} queued`;

  return (
    <div
      className={cn("mb-2 flex flex-col gap-1.5", className)}
      data-slot="chat-message-queue"
    >
      <p className="px-0.5 text-[11px] font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
        Send after this reply · {countLabel}
      </p>
      <ul aria-label="Queued messages" className="flex flex-col gap-1.5">
        {items.map((item) => (
          <QueueItem
            key={item.id}
            item={item}
            onRemove={onRemove}
            onUpdateText={onUpdateText}
          />
        ))}
      </ul>
    </div>
  );
}
