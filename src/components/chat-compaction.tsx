"use client";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { ChatMessageParts } from "@/components/chat-message-parts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ChatDisplayItem } from "@/lib/chat/compaction";
import {
  groupMessagesForDisplay,
  isCompactionMessage,
  isSummaryMessage,
} from "@/lib/chat/compaction";
import type { UIMessage } from "ai";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";

function CompactionDivider() {
  return (
    <div
      className="flex items-center gap-3 py-1"
      data-slot="compaction-divider"
    >
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      <p className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Session compacted
      </p>
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

function CompactionSummary({
  message,
  isLastMessage,
  isStreaming,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
}) {
  const text = message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim();

  return (
    <div
      className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60"
      data-slot="compaction-summary"
    >
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Summary
      </p>
      {text ? (
        <MessageResponse isAnimating={isLastMessage && isStreaming}>
          {text}
        </MessageResponse>
      ) : null}
    </div>
  );
}

function TimelineMessage({
  message,
  isLastMessage,
  isStreaming,
  activityLabel,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  activityLabel?: string | null;
}) {
  return (
    <Message from={message.role}>
      <MessageContent>
        <ChatMessageParts
          activityLabel={activityLabel}
          isLastMessage={isLastMessage}
          isStreaming={isStreaming}
          message={message}
        />
      </MessageContent>
    </Message>
  );
}

function SealedLayer({ messages }: { messages: UIMessage[] }) {
  const count = messages.length;

  return (
    <Collapsible className="w-full">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span>
          Earlier conversation compacted ({count}{" "}
          {count === 1 ? "message" : "messages"})
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 flex flex-col gap-4">
        {messages.map((message, index) => (
          <DisplayItemView
            activityLabel={null}
            isLastMessage={false}
            isStreaming={false}
            item={sealedDisplayItem(message)}
            key={`${message.id}-${index}`}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function sealedDisplayItem(message: UIMessage): ChatDisplayItem {
  if (isCompactionMessage(message)) {
    return { type: "divider", message };
  }
  if (isSummaryMessage(message)) {
    return { type: "summary", message };
  }
  return { type: "message", message };
}

function displayItemKey(item: ChatDisplayItem, index: number): string {
  if (item.type === "sealed") {
    return `sealed-${item.messages[0]?.id ?? index}`;
  }
  return `${item.type}-${item.message.id}`;
}

function DisplayItemView({
  item,
  isLastMessage,
  isStreaming,
  activityLabel,
}: {
  item: ChatDisplayItem;
  isLastMessage: boolean;
  isStreaming: boolean;
  activityLabel?: string | null;
}) {
  if (item.type === "sealed") {
    return <SealedLayer messages={item.messages} />;
  }
  if (item.type === "divider") {
    return <CompactionDivider />;
  }
  if (item.type === "summary") {
    return (
      <CompactionSummary
        isLastMessage={isLastMessage}
        isStreaming={isStreaming}
        message={item.message}
      />
    );
  }
  return (
    <TimelineMessage
      activityLabel={activityLabel}
      isLastMessage={isLastMessage}
      isStreaming={isStreaming}
      message={item.message}
    />
  );
}

export function ChatTimeline({
  messages,
  isStreaming,
  activityLabel,
}: {
  messages: UIMessage[];
  isStreaming: boolean;
  activityLabel?: string | null;
}) {
  const items = useMemo(
    () => groupMessagesForDisplay(messages),
    [messages],
  );
  const lastMessage = messages.at(-1);

  return (
    <>
      {items.map((item, index) => {
        const isLast =
          item.type !== "sealed" && item.message.id === lastMessage?.id;
        const itemActivityLabel =
          isLast && item.type === "message" && item.message.role === "assistant"
            ? activityLabel
            : null;
        return (
          <DisplayItemView
            activityLabel={itemActivityLabel}
            isLastMessage={isLast}
            isStreaming={isStreaming}
            item={item}
            key={displayItemKey(item, index)}
          />
        );
      })}
    </>
  );
}
