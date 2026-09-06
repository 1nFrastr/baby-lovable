"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { ChatActivityLabel } from "@/components/chat-activity-label";
import {
  compactToolInput,
  formatToolPartLabel,
  formatToolPartOutput,
} from "@/lib/chat/format-tool-label";
import { truncateReasoningText } from "@/lib/chat/reasoning-text";
import { joinReasoningText } from "@/lib/chat/turn-progress";
import { cn } from "@/lib/utils";
import {
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** ~6 lines of text-sm; long user prompts stay collapsed until expanded. */
const USER_MESSAGE_COLLAPSE_CLASS = "max-h-36 overflow-hidden";

function collectTextParts(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function UserMessageText({ text }: { text: string }) {
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }

    const measure = () => {
      if (expanded) {
        return;
      }
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="min-w-0">
      <div className="relative">
        <p
          className={cn(
            "whitespace-pre-wrap break-words",
            !expanded && USER_MESSAGE_COLLAPSE_CLASS,
          )}
          ref={contentRef}
        >
          {text}
        </p>
        {overflows && !expanded ? (
          <button
            aria-expanded={false}
            className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-secondary from-35% to-transparent pt-8 text-left text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            onClick={() => setExpanded(true)}
            type="button"
          >
            Show more
          </button>
        ) : null}
      </div>
      {overflows && expanded ? (
        <button
          aria-expanded={true}
          className="mt-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          onClick={() => setExpanded(false)}
          type="button"
        >
          Show less
        </button>
      ) : null}
    </div>
  );
}

function BuilderToolPart({
  part,
}: {
  part: ToolUIPart | DynamicToolUIPart;
}) {
  const outputLine = formatToolPartOutput(part);
  const errorText = "errorText" in part ? part.errorText : undefined;

  return (
    <Tool defaultOpen={false}>
      {part.type === "dynamic-tool" ? (
        <ToolHeader
          state={part.state}
          title={formatToolPartLabel(part)}
          toolName={part.toolName}
          type="dynamic-tool"
        />
      ) : (
        <ToolHeader
          state={part.state}
          title={formatToolPartLabel(part)}
          type={part.type}
        />
      )}
      <ToolContent>
        <ToolInput input={compactToolInput(part)} />
        <ToolOutput
          errorText={errorText}
          output={
            outputLine != null ? (
              <p className="px-2 py-1.5 font-mono text-xs">{outputLine}</p>
            ) : undefined
          }
        />
      </ToolContent>
    </Tool>
  );
}

function isReasoningPart(
  part: UIMessage["parts"][number],
): part is Extract<UIMessage["parts"][number], { type: "reasoning" }> {
  return part.type === "reasoning";
}

function ReasoningBlock({
  parts,
  isStreaming,
}: {
  parts: Extract<UIMessage["parts"][number], { type: "reasoning" }>[];
  isStreaming: boolean;
}) {
  const reasoningText = truncateReasoningText(joinReasoningText(parts));

  return (
    <Reasoning defaultOpen={false} isStreaming={isStreaming}>
      <ReasoningTrigger />
      <ReasoningContent>{reasoningText}</ReasoningContent>
    </Reasoning>
  );
}

export function ChatMessageParts({
  message,
  isLastMessage,
  isStreaming,
  activityLabel,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  /** Idle planning label; rendered in the same column/gap as tool rows. */
  activityLabel?: string | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col gap-0.5">
        <UserMessageText text={collectTextParts(message)} />
      </div>
    );
  }

  const lastPartIndex = message.parts.length - 1;
  const nodes: ReactNode[] = [];
  let reasoningRun: {
    startIndex: number;
    parts: Extract<UIMessage["parts"][number], { type: "reasoning" }>[];
  } | null = null;

  const flushReasoning = () => {
    if (!reasoningRun) {
      return;
    }

    const isTrailing =
      reasoningRun.startIndex + reasoningRun.parts.length - 1 ===
      lastPartIndex;
    const isGroupStreaming =
      isLastMessage &&
      isStreaming &&
      (isTrailing ||
        reasoningRun.parts.some((part) => part.state === "streaming"));

    nodes.push(
      <ReasoningBlock
        isStreaming={isGroupStreaming}
        key={`${message.id}-reasoning-${reasoningRun.startIndex}`}
        parts={reasoningRun.parts}
      />,
    );
    reasoningRun = null;
  };

  message.parts.forEach((part, index) => {
    if (isReasoningPart(part)) {
      if (reasoningRun) {
        reasoningRun.parts.push(part);
      } else {
        reasoningRun = { startIndex: index, parts: [part] };
      }
      return;
    }

    flushReasoning();

    if (part.type === "text") {
      nodes.push(
        <MessageResponse
          isAnimating={isLastMessage && isStreaming && index === lastPartIndex}
          key={`${message.id}-${index}`}
        >
          {part.text}
        </MessageResponse>,
      );
      return;
    }

    if (isToolUIPart(part)) {
      nodes.push(
        <BuilderToolPart
          key={`${message.id}-tool-${part.toolCallId}`}
          part={part}
        />,
      );
    }
    // data-compaction and other non-renderable parts are ignored.
  });

  flushReasoning();

  if (activityLabel) {
    nodes.push(
      <ChatActivityLabel key={`${message.id}-activity`} label={activityLabel} />,
    );
  }

  return <div className="flex flex-col gap-0.5">{nodes}</div>;
}
