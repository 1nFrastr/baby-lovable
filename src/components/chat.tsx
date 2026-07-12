"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useMemo, useRef } from "react";

interface ChatProps {
  sessionId: string;
  initialMessages?: UIMessage[];
}

export function Chat({ sessionId, initialMessages = [] }: ChatProps) {
  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: `/api/sessions/${sessionId}/chat`,
        maxConsecutiveErrors: 5,
        initialStartIndex: -50,
      }),
    [sessionId],
  );

  const { messages, sendMessage, status, setMessages } = useChat({
    transport,
    messages: initialMessages,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages, sessionId, setMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input?.value.trim() || status === "streaming") {
      return;
    }

    sendMessage({ text: input.value });
    input.value = "";
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Project Chat
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Session {sessionId}
        </p>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="mt-20 text-center text-zinc-400 dark:text-zinc-500">
            <p className="mb-2 text-lg">描述你想构建的 Next.js 应用</p>
            <p className="text-sm">
              例如：「创建一个待办事项应用,支持添加、完成和删除任务」
            </p>
          </div>
        )}

        {messages.map((message) => (
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
