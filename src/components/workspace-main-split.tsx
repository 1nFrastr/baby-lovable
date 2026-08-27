"use client";

import type { ReactNode } from "react";

import { ResizeHandle } from "@/components/resize-handle";
import { CHAT_RATIO_MAX, CHAT_RATIO_MIN } from "@/lib/workspace-layout";

interface WorkspaceMainSplitProps {
  chatRatio: number;
  isDragging: boolean;
  left: ReactNode;
  right: ReactNode;
  onResize: (clientX: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onNudge: (direction: -1 | 1) => void;
}

export function WorkspaceMainSplit({
  chatRatio,
  isDragging,
  left,
  right,
  onResize,
  onDragStart,
  onDragEnd,
  onNudge,
}: WorkspaceMainSplitProps) {
  const chatPercent = Math.round(chatRatio * 100);

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div
        className="relative flex h-full min-h-0 min-w-[240px] flex-col overflow-hidden"
        style={{ flex: `${chatRatio} 1 0%` }}
      >
        {left}
        {isDragging ? (
          <div className="absolute inset-0 z-10" aria-hidden="true" />
        ) : null}
      </div>
      <ResizeHandle
        label="Resize chat and preview"
        valueNow={chatPercent}
        valueMin={Math.round(CHAT_RATIO_MIN * 100)}
        valueMax={Math.round(CHAT_RATIO_MAX * 100)}
        valueText={`Chat ${chatPercent}%, preview ${100 - chatPercent}%`}
        onDrag={onResize}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onNudge={onNudge}
      />
      <div
        className="relative flex h-full min-h-0 min-w-[280px] flex-col overflow-hidden"
        style={{ flex: `${1 - chatRatio} 1 0%` }}
      >
        {right}
        {isDragging ? (
          <div className="absolute inset-0 z-10" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
}
