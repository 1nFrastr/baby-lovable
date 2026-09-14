"use client";

import { Monitor, Smartphone } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  IPHONE_VIEWPORT,
  mobilePreviewFitScale,
  mobilePreviewFrameSize,
  type PreviewViewportMode,
} from "@/lib/preview/viewport";
import { cn } from "@/lib/utils";

const toolbarToggleClass =
  "flex h-6 w-6 items-center justify-center rounded transition";

export function PreviewViewportToggle({
  mode,
  onChange,
}: {
  mode: PreviewViewportMode;
  onChange: (mode: PreviewViewportMode) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700"
      role="group"
      aria-label="Preview viewport"
    >
      <button
        type="button"
        aria-pressed={mode === "desktop"}
        onClick={() => onChange("desktop")}
        className={cn(
          toolbarToggleClass,
          mode === "desktop"
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800",
        )}
        title="Desktop"
        aria-label="Desktop viewport"
      >
        <Monitor className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-pressed={mode === "mobile"}
        onClick={() => onChange("mobile")}
        className={cn(
          toolbarToggleClass,
          mode === "mobile"
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800",
        )}
        title={`Mobile · iPhone ${IPHONE_VIEWPORT.width}×${IPHONE_VIEWPORT.height}`}
        aria-label="Mobile viewport"
      >
        <Smartphone className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

export function PreviewViewportFrame({
  mode,
  children,
}: {
  mode: PreviewViewportMode;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const isMobile = mode === "mobile";
  const frame = mobilePreviewFrameSize();

  useLayoutEffect(() => {
    if (!isMobile) {
      return;
    }

    const el = containerRef.current;
    if (!el) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (!size) {
        return;
      }
      setScale(mobilePreviewFitScale(size.width, size.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isMobile]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0",
        isMobile &&
          "flex items-center justify-center overflow-hidden bg-zinc-200/90 dark:bg-zinc-900",
      )}
    >
      <div
        className={isMobile ? "relative shrink-0" : "h-full w-full"}
        style={
          isMobile
            ? { width: frame.width * scale, height: frame.height * scale }
            : undefined
        }
      >
        <div
          className={
            isMobile
              ? "absolute top-0 left-0 overflow-hidden rounded-[2.75rem] bg-zinc-950 shadow-xl dark:bg-zinc-800"
              : "h-full w-full"
          }
          style={
            isMobile
              ? {
                  width: frame.width,
                  height: frame.height,
                  padding: IPHONE_VIEWPORT.bezel,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                }
              : undefined
          }
        >
          <div
            className={
              isMobile
                ? "h-full w-full overflow-hidden rounded-[2.1rem] bg-white"
                : "h-full w-full"
            }
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
