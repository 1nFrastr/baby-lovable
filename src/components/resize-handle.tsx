"use client";

import { useCallback, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  label: string;
  onDrag: (clientX: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onNudge?: (direction: -1 | 1) => void;
  onDoubleClick?: () => void;
  valueNow?: number;
  valueMin?: number;
  valueMax?: number;
  valueText?: string;
}

export function ResizeHandle({
  label,
  onDrag,
  onDragStart,
  onDragEnd,
  onNudge,
  onDoubleClick,
  valueNow,
  valueMin,
  valueMax,
  valueText,
}: ResizeHandleProps) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const stopDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) {
        return;
      }
      draggingRef.current = false;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      onDragEnd?.();
    },
    [onDragEnd],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={valueNow}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuetext={valueText}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        draggingRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        onDragStart?.();
        onDrag(event.clientX);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) {
          return;
        }
        onDrag(event.clientX);
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (!onNudge) {
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onNudge(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onNudge(1);
        }
      }}
      className={cn(
        "group relative z-20 w-1.5 shrink-0 cursor-col-resize touch-none outline-none",
        "focus-visible:bg-blue-500/40",
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors",
          "group-hover:bg-blue-500 group-focus-visible:bg-blue-500",
          dragging && "bg-blue-500",
        )}
      />
    </div>
  );
}
