"use client";

import { ListCollapse } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SlashCommand } from "@/lib/chat/slash-commands";

const COMMAND_ICONS: Record<string, typeof ListCollapse> = {
  summarize: ListCollapse,
};

export function SlashCommandMenu({
  commands,
  highlight,
  onHighlight,
  onSelect,
}: {
  commands: SlashCommand[];
  highlight: number;
  onHighlight: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
}) {
  return (
    <div
      aria-label="Commands"
      className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
      id="slash-command-list"
      role="listbox"
    >
      <p className="border-b border-zinc-100 px-3 py-1.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase dark:border-zinc-800">
        Commands
      </p>
      {commands.length === 0 ? (
        <p className="px-3 py-3 text-sm text-zinc-500">No commands found</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto p-1">
          {commands.map((command, index) => {
            const Icon = COMMAND_ICONS[command.name] ?? ListCollapse;
            const selected = index === highlight;
            return (
              <li key={command.name}>
                <button
                  aria-selected={selected}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm",
                    selected
                      ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                      : "text-zinc-800 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-900",
                  )}
                  id={`slash-command-${command.name}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(command);
                  }}
                  onMouseEnter={() => onHighlight(index)}
                  role="option"
                  type="button"
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono font-medium">/{command.name}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                      {command.description}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
