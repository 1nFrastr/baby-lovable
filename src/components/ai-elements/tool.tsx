"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";
import { Shimmer } from "./shimmer";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose w-full", className)}
    {...props}
  />
);

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
  const isError = state === "output-error" || state === "output-denied";
  const isRunning = isRunningState(state);

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-1.5 py-0.5 text-left text-sm transition-colors",
        isError
          ? "text-destructive hover:text-destructive"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate font-normal">
        {isRunning ? (
          <Shimmer as="span" className="text-sm" duration={1.5}>
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </span>
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
          "opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100",
          "group-data-[state=open]:rotate-180",
        )}
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "overflow-hidden text-popover-foreground outline-none",
      "data-[state=closed]:animate-out data-[state=open]:animate-in",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
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
        <p className="text-destructive text-xs">{errorText}</p>
      ) : null}
      {output ? (
        <div
          className={cn(
            "overflow-x-auto rounded-md text-xs [&_table]:w-full",
            errorText
              ? "bg-destructive/10 text-destructive"
              : "bg-muted/40 text-muted-foreground",
          )}
        >
          {Output}
        </div>
      ) : null}
    </div>
  );
};
