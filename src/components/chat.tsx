"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  claimResumeLock,
  findDuplicateMessageIds,
  normalizeChatMessages,
  prepareMessagesForResume,
  releaseResumeLock,
} from "@/lib/chat/resume-messages";
import { isActiveRunStatus, type SessionRunStatus } from "@/lib/session/types";

function messagesShallowEqual(left: UIMessage[], right: UIMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => message.id === right[index]?.id);
}

interface ChatProps {
  sessionId: string;
  initialMessages?: UIMessage[];
  lastRunId?: string;
  runStatus?: SessionRunStatus;
  onSessionRefresh?: () => void;
}

export function Chat({
  sessionId,
  initialMessages = [],
  lastRunId,
  runStatus = "idle",
  onSessionRefresh,
}: ChatProps) {
  const shouldResume =
    Boolean(lastRunId) && isActiveRunStatus(runStatus);

  const messagesForChat = useMemo(
    () =>
      shouldResume
        ? prepareMessagesForResume(initialMessages)
        : normalizeChatMessages(initialMessages),
    [initialMessages, shouldResume],
  );

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: `/api/sessions/${sessionId}/chat`,
        maxConsecutiveErrors: 5,
        // Replay the full in-flight turn so intro text before tool calls is not
        // truncated when a multi-step agent emits hundreds of stream chunks.
        initialStartIndex: 0,
        prepareReconnectToStreamRequest: lastRunId
          ? async () => ({
              api: `/api/sessions/${sessionId}/chat/${encodeURIComponent(lastRunId)}/stream`,
            })
          : undefined,
        onChatEnd: () => {
          if (lastRunId) {
            releaseResumeLock(sessionId, lastRunId);
          }
          onSessionRefresh?.();
        },
      }),
    [lastRunId, onSessionRefresh, sessionId],
  );

  const { messages, sendMessage, status, setMessages, error, resumeStream } =
    useChat({
      id: sessionId,
      transport,
      messages: messagesForChat,
      onError: () => {
        if (lastRunId) {
          releaseResumeLock(sessionId, lastRunId);
        }
        onSessionRefresh?.();
      },
    });

  const displayMessages = useMemo(
    () => normalizeChatMessages(messages),
    [messages],
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lastRunId || shouldResume) {
      return;
    }
    releaseResumeLock(sessionId, lastRunId);
  }, [shouldResume, sessionId, lastRunId]);

  useEffect(() => {
    if (!shouldResume || !lastRunId) {
      return;
    }

    if (!claimResumeLock(sessionId, lastRunId)) {
      return;
    }

    void resumeStream();

    return () => {
      // Keep the lock for the run — Strict Mode's cleanup remount must not
      // start a second stream for the same workflow run.
    };
  }, [shouldResume, resumeStream, sessionId, lastRunId]);

  useEffect(() => {
    if (shouldResume) {
      return;
    }

    const next = normalizeChatMessages(initialMessages);
    setMessages((current) =>
      messagesShallowEqual(current, next) ? current : next,
    );
  }, [initialMessages, sessionId, setMessages, shouldResume]);

  useEffect(() => {
    if (!shouldResume) {
      return;
    }

    const normalized = normalizeChatMessages(messages);
    if (
      normalized.length === messages.length &&
      findDuplicateMessageIds(messages).length === 0
    ) {
      return;
    }

    setMessages((current) =>
      messagesShallowEqual(current, normalized) ? current : normalized,
    );
  }, [messages, setMessages, shouldResume]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayMessages]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const input = inputRef.current;
      if (!input?.value.trim() || status === "streaming") {
        return;
      }

      sendMessage({ text: input.value });
      input.value = "";
    },
    [sendMessage, status],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Project Chat
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Session {sessionId}
          {shouldResume ? " · resuming stream…" : ""}
          {error ? ` · ${error.message}` : ""}
        </p>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {displayMessages.length === 0 && (
          <div className="mt-20 text-center text-zinc-400 dark:text-zinc-500">
            <p className="mb-2 text-lg">描述你想构建的 Next.js 应用</p>
            <p className="text-sm">
              例如：「创建一个待办事项应用,支持添加、完成和删除任务」
            </p>
          </div>
        )}

        {displayMessages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                message.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
              }`}
            >
              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  return <p key={index}>{part.text}</p>;
                }

                if (isToolUIPart(part)) {
                  const toolName = getToolName(part);
                  return (
                    <div
                      key={index}
                      className="mt-1 font-mono text-xs opacity-70"
                    >
                      {toolName}
                      {part.state === "output-available" &&
                        part.output != null &&
                        ` → ${JSON.stringify(part.output).slice(0, 120)}`}
                    </div>
                  );
                }

                return null;
              })}
            </div>
          </div>
        ))}

        {status === "streaming" && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-zinc-100 px-4 py-2.5 dark:bg-zinc-800">
              <span className="inline-flex gap-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.1s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.2s]" />
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-200 px-6 py-4 dark:border-zinc-800"
      >
        <div className="flex gap-3">
          <input
            ref={inputRef}
            type="text"
            placeholder="描述你的 Next.js 应用需求…"
            disabled={status === "streaming"}
            className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={status === "streaming"}
            className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
