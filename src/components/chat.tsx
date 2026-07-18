"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { isToolUIPart, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  formatToolPartLabel,
  formatToolPartOutput,
} from "@/lib/chat/format-tool-label";
import { extractAppTestStatusFromMessages } from "@/lib/chat/app-test-from-messages";
import {
  extractLatestSuccessfulCheckPreview,
  type CheckPreviewOkSignal,
} from "@/lib/chat/check-preview-from-messages";
import {
  hasAssistantParts,
  mergeDisplayMessages,
  persistedMessagesLagChat,
} from "@/lib/chat/merge-messages";
import { isActiveRunStatus, type SessionRunStatus } from "@/lib/session/types";
import type { SandboxMode } from "@/lib/sandbox/types";

const STICK_TO_BOTTOM_THRESHOLD_PX = 80;

/** Sent when the user clicks Auto Test in the composer. */
const APP_TEST_USER_PROMPT = "Please run a quick happy-path UI test of the main flow.";

interface ChatProps {
  sessionId: string;
  /** Completed messages from session.json (persistent layer). */
  messages: UIMessage[];
  /** In-flight assistant from draft.json (cache layer); null when idle. */
  draft: UIMessage | null;
  runStatus?: SessionRunStatus;
  sandboxMode?: SandboxMode;
  onSessionRefresh?: () => void;
  /** Live View URL / running state from streamed testPreview tool output. */
  onAppTestStatus?: (
    status: import("@/lib/browser-run/run-status").AppTestLatestStatus | null,
  ) => void;
  /** Fires when a new successful checkPreview appears (skips history on hydrate). */
  onCheckPreviewOk?: (signal: CheckPreviewOkSignal) => void;
}

export function Chat({
  sessionId,
  messages,
  draft,
  runStatus = "idle",
  sandboxMode = "local",
  onSessionRefresh,
  onAppTestStatus,
  onCheckPreviewOk,
}: ChatProps) {
  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: `/api/sessions/${sessionId}/chat`,
        maxConsecutiveErrors: 3,
        onChatEnd: () => {
          onSessionRefresh?.();
        },
      }),
    [onSessionRefresh, sessionId],
  );

  const {
    messages: chatMessages,
    setMessages,
    sendMessage,
    status,
    error,
  } = useChat({
    id: sessionId,
    transport,
    messages,
    onError: () => {
      onSessionRefresh?.();
    },
  });

  const isLiveTurn =
    status === "streaming" ||
    status === "submitted" ||
    isActiveRunStatus(runStatus);

  const displayMessages = useMemo(
    () => mergeDisplayMessages(messages, chatMessages, draft, isLiveTurn),
    [messages, chatMessages, draft, isLiveTurn],
  );

  useEffect(() => {
    if (!onAppTestStatus) {
      return;
    }
    onAppTestStatus(extractAppTestStatusFromMessages(displayMessages));
  }, [displayMessages, onAppTestStatus]);

  const checkPreviewSeededRef = useRef(false);
  const lastCheckPreviewOkIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onCheckPreviewOk) {
      return;
    }

    const signal = extractLatestSuccessfulCheckPreview(displayMessages);
    if (!checkPreviewSeededRef.current) {
      checkPreviewSeededRef.current = true;
      lastCheckPreviewOkIdRef.current = signal?.toolCallId ?? null;
      return;
    }

    if (!signal || signal.toolCallId === lastCheckPreviewOkIdRef.current) {
      return;
    }

    lastCheckPreviewOkIdRef.current = signal.toolCallId;
    onCheckPreviewOk(signal);
  }, [displayMessages, onCheckPreviewOk]);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastSyncedPersistedRef = useRef("");

  // useChat only reads `messages` on mount; sync completed history from disk
  // between turns so the next POST includes prior assistant replies.
  useEffect(() => {
    if (isLiveTurn) {
      return;
    }

    // Runtime projection can mark the run idle before session detail refetch
    // returns the committed assistant — never clobber the live thread with that.
    if (persistedMessagesLagChat(messages, chatMessages)) {
      return;
    }

    const fingerprint = messages.map((message) => message.id).join("|");
    if (fingerprint === lastSyncedPersistedRef.current) {
      return;
    }
    lastSyncedPersistedRef.current = fingerprint;

    // Persisted history is authoritative between turns; merging would keep a
    // stale SSE assistant id alongside the saved draft id.
    setMessages(messages);
  }, [chatMessages, isLiveTurn, messages, setMessages]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottomRef.current =
      distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return;
    }

    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayMessages, isLiveTurn]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const input = inputRef.current;
      if (!input?.value.trim() || isLiveTurn) {
        return;
      }

      const trimmed = input.value.trim();
      stickToBottomRef.current = true;
      void sendMessage({ text: trimmed });
      input.value = "";
      onSessionRefresh?.();
    },
    [isLiveTurn, onSessionRefresh, sendMessage],
  );

  const handleRunAppTest = useCallback(() => {
    if (isLiveTurn) {
      return;
    }
    stickToBottomRef.current = true;
    void sendMessage({ text: APP_TEST_USER_PROMPT });
    if (inputRef.current) {
      inputRef.current.value = "";
    }
    onSessionRefresh?.();
  }, [isLiveTurn, onSessionRefresh, sendMessage]);

  const showStreamingIndicator =
    isLiveTurn &&
    !hasAssistantParts(displayMessages[displayMessages.length - 1]);

  // After the first completed turn only; hide while a turn is in flight.
  const showAppTestButton =
    sandboxMode === "daytona" &&
    !isLiveTurn &&
    displayMessages.some((message) => message.role === "assistant");

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Project Chat
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Session {sessionId}
          {isLiveTurn ? " · running…" : ""}
          {error ? ` · ${error.message}` : ""}
        </p>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full space-y-4 overflow-y-auto px-6 py-4"
        >
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
                    const label = formatToolPartLabel(part);
                    const streamingInput = part.state === "input-streaming";
                    const outputLine = formatToolPartOutput(part);

                    return (
                      <div
                        key={index}
                        className="mt-1 font-mono text-xs opacity-70"
                      >
                        {label}
                        {streamingInput && (
                          <span className="opacity-60"> …</span>
                        )}
                        {outputLine != null ? ` → ${outputLine}` : null}
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            </div>
          ))}

          {showStreamingIndicator && (
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

        {showAppTestButton ? (
          <button
            type="button"
            onClick={handleRunAppTest}
            disabled={isLiveTurn}
            title="Send a message asking the agent to run a happy-path UI test"
            className="absolute bottom-4 right-4 z-10 rounded-full border border-zinc-200 bg-white/95 px-3.5 py-2 text-xs font-medium text-zinc-700 shadow-md backdrop-blur transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Auto Test
          </button>
        ) : null}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-200 px-6 py-4 dark:border-zinc-800"
      >
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="text"
            placeholder="描述你的 Next.js 应用需求…"
            disabled={isLiveTurn}
            className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={isLiveTurn}
            className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
