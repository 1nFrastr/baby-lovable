"use client";

import type { SourceControlProjection } from "@/lib/git/types";

const LABELS: Record<
  SourceControlProjection["status"],
  { text: string; className: string }
> = {
  idle: {
    text: "未启用",
    className:
      "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  },
  preparing: {
    text: "准备代码库…",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  ready: {
    text: "已就绪",
    className:
      "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  },
  syncing: {
    text: "正在保存…",
    className:
      "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  },
  synced: {
    text: "已保存",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  },
  error: {
    text: "保存失败",
    className:
      "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  },
  conflict: {
    text: "代码冲突",
    className:
      "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  },
};

interface SourceControlStatusChipProps {
  sourceControl?: SourceControlProjection | null;
  /** Hide when local / idle with nothing useful to show. */
  visible?: boolean;
}

export function SourceControlStatusChip({
  sourceControl,
  visible = true,
}: SourceControlStatusChipProps) {
  if (!visible || !sourceControl || sourceControl.status === "idle") {
    return null;
  }

  const label = LABELS[sourceControl.status] ?? LABELS.idle;
  const sha = sourceControl.shortSha;
  const github = sourceControl.githubRepoName;
  const title = [
    sourceControl.error ?? label.text,
    sha,
    github ? `GitHub ${github}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className={`inline-flex max-w-[10rem] items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${label.className}`}
      title={title}
      aria-label={title}
      role="status"
      aria-live="polite"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80"
        aria-hidden
      />
      <span className="hidden truncate @[380px]:inline">
        {label.text}
        {sha ? (
          <span className="ml-1 font-mono font-normal opacity-80">{sha}</span>
        ) : null}
      </span>
    </span>
  );
}
