"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useCallback } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

import { CodeBlock } from "./code-block";
import { Shimmer } from "./shimmer";

export type ToolProps = ComponentProps<typeof Collapsible>;

/**
 * Tool disclosure. Named `group/tool` so the chevron only appears when this
 * row is hovered — not when hovering sibling text in the same Message `group`.
 *
 * On toggle, stop StickToBottom resize-follow so the header stays pinned and
 * content expands downward instead of the viewport sliding the header up.
 */
export const Tool = ({ className, onOpenChange, ...props }: ToolProps) => {
  const { stopScroll } = useStickToBottomContext();

  const handleOpenChange = useCallback(
    (open: boolean) => {
      // Opening grows content below the header; unlock stick-to-bottom so the
      // resize follower does not slide the trigger upward out of view.
      if (open) {
        stopScroll();
      }
      onOpenChange?.(open);
    },
    [onOpenChange, stopScroll],
  );

  return (
    <Collapsible
      className={cn("group/tool not-prose w-full", className)}
      onOpenChange={handleOpenChange}
      {...props}
    />
  );
};

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

function isRunningState(state: ToolPart["state"]) {
  return (
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested"
  );
}

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const label = title ?? derivedName;
  const isRunning = isRunningState(state);

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-1.5 py-0.5 text-left text-sm transition-colors",
        "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate font-normal">
        {isRunning ? (
          <Shimmer as="span" className="text-sm" duration={1.5}>
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </span>
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground/60 transition-[opacity,transform] duration-150",
          "opacity-0 group-hover/tool:opacity-100 group-data-[state=open]/tool:opacity-100",
          "group-data-[state=open]/tool:rotate-90",
        )}
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      // Keep the trigger row fixed; only this block grows downward.
      "overflow-hidden text-popover-foreground outline-none",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  if (input == null) {
    return null;
  }

  const isEmptyObject =
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input as object).length === 0;

  if (isEmptyObject) {
    return null;
  }

  return (
    <div className={cn("mt-1 overflow-hidden pl-0.5", className)} {...props}>
      <div className="rounded-md bg-muted/40">
        <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output: ReactNode = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("mt-1 space-y-1 pl-0.5", className)} {...props}>
      {errorText ? (
        <p className="text-muted-foreground/80 text-xs">{errorText}</p>
      ) : null}
      {output ? (
        <div
          className={cn(
            "overflow-x-auto rounded-md bg-muted/40 text-xs text-muted-foreground [&_table]:w-full",
          )}
        >
          {Output}
        </div>
      ) : null}
    </div>
  );
};
