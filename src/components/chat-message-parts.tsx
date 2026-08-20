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
import {
  compactToolInput,
  formatToolPartLabel,
  formatToolPartOutput,
} from "@/lib/chat/format-tool-label";
import {
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import type { ReactNode } from "react";

function BuilderToolPart({
  part,
}: {
  part: ToolUIPart | DynamicToolUIPart;
}) {
  const outputLine = formatToolPartOutput(part);
  const errorText = "errorText" in part ? part.errorText : undefined;
  const isError = part.state === "output-error";

  return (
    <Tool defaultOpen={isError}>
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
  const reasoningText = parts.map((part) => part.text).join("\n\n");

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
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
}) {
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

    const isGroupStreaming =
      isLastMessage &&
      isStreaming &&
      reasoningRun.parts.some((part) => part.state === "streaming");

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
        <BuilderToolPart key={`${message.id}-${index}`} part={part} />,
      );
    }
  });

  flushReasoning();

  return <div className="flex flex-col gap-0.5">{nodes}</div>;
}
