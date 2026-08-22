"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Streamdown } from "streamdown";
import { useStickToBottomContext } from "use-stick-to-bottom";

import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const { stopScroll } = useStickToBottomContext();
    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const startTimeRef = useRef<number | null>(null);

    useEffect(() => {
      if (isStreaming) {
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
        return;
      }

      if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        // Same as tools: keep the trigger pinned when content grows downward.
        if (newOpen) {
          stopScroll();
        }
        setIsOpen(newOpen);
      },
      [setIsOpen, stopScroll],
    );

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("group/reasoning not-prose w-full", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return (
      <Shimmer as="span" className="text-sm" duration={1.5}>
        Thinking
      </Shimmer>
    );
  }
  if (duration === undefined) {
    return "Thought for a few seconds";
  }
  return `Thought for ${duration} second${duration === 1 ? "" : "s"}`;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <span className="min-w-0 truncate font-normal">
              {getThinkingMessage(isStreaming, duration)}
            </span>
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/60 transition-[opacity,transform] duration-150",
                "opacity-0 group-hover/reasoning:opacity-100 group-data-[state=open]/reasoning:opacity-100",
                "group-data-[state=open]/reasoning:rotate-90",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = HTMLAttributes<HTMLDivElement> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const { isOpen } = useReasoning();

    if (!isOpen) {
      return null;
    }

    return (
      <div
        className={cn(
          "mt-1 overflow-hidden pl-0.5 text-muted-foreground text-sm outline-none",
          className,
        )}
        {...props}
      >
        <Streamdown mode="static">{children}</Streamdown>
      </div>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
