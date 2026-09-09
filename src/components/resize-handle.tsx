"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";

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

function applyDragCursor() {
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function clearDragCursor() {
  document.body.style.removeProperty("cursor");
  document.body.style.removeProperty("user-select");
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
  const handleRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const stopDragRef = useRef<() => void>(() => {});
  const [dragging, setDragging] = useState(false);

  const onDragRef = useRef(onDrag);
  const onDragStartRef = useRef(onDragStart);
  const onDragEndRef = useRef(onDragEnd);
  onDragRef.current = onDrag;
  onDragStartRef.current = onDragStart;
  onDragEndRef.current = onDragEnd;

  stopDragRef.current = () => {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    const pointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    setDragging(false);

    const node = handleRef.current;
    if (node && pointerId != null) {
      try {
        if (node.hasPointerCapture(pointerId)) {
          node.releasePointerCapture(pointerId);
        }
      } catch {
        // Node detached or pointer already released.
      }
    }

    clearDragCursor();
    onDragEndRef.current?.();
  };

  useEffect(() => {
    return () => {
      stopDragRef.current();
    };
  }, []);

  useLayoutEffect(() => {
    if (!dragging) {
      return;
    }

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) {
        return;
      }
      onDragRef.current(event.clientX);
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) {
        return;
      }
      stopDragRef.current();
    };

    const onMouseUp = () => {
      stopDragRef.current();
    };

    const onBlur = () => {
      stopDragRef.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        stopDragRef.current();
      }
    };

    const onLostPointerCapture = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) {
        return;
      }
      // Overlay/iframe can drop capture while the button is still down; window
      // listeners keep the drag alive. If the button is already up, we missed
      // pointerup (typical over a cross-origin iframe) and must unstick.
      if (event.buttons === 0) {
        stopDragRef.current();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    const node = handleRef.current;
    node?.addEventListener("lostpointercapture", onLostPointerCapture);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
      node?.removeEventListener("lostpointercapture", onLostPointerCapture);
    };
  }, [dragging]);

  return (
    <div
      ref={handleRef}
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
        activePointerIdRef.current = event.pointerId;
        applyDragCursor();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer may already be gone.
        }
        flushSync(() => {
          setDragging(true);
        });
        onDragStartRef.current?.();
        onDragRef.current(event.clientX);
      }}
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
      {dragging
        ? createPortal(
            <div
              className="fixed inset-0 z-[200] cursor-col-resize bg-black/0"
              aria-hidden="true"
            />,
            document.body,
          )
        : null}
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
