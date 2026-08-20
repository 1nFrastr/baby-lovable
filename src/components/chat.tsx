"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import type { UIMessage } from "ai";
import { FlaskConical, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { ChatMessageParts } from "@/components/chat-message-parts";
import { Spinner } from "@/components/ui/spinner";
import { extractAppTestStatusFromMessages } from "@/lib/chat/app-test-from-messages";
import {
  hasAssistantParts,
  mergeDisplayMessages,
  persistedMessagesLagChat,
} from "@/lib/chat/merge-messages";
import {
  isActiveRunStatus,
  isLiveChatTurn,
  type SessionRunStatus,
} from "@/lib/session/types";

/** Sent when the user clicks Auto Test in the composer. */
const APP_TEST_USER_PROMPT =
  "Please run a quick happy-path UI test of the main flow.";

interface ChatProps {
  sessionId: string;
  /** Completed messages from the Supabase session row. */
  messages: UIMessage[];
  /** In-flight assistant from the Supabase draft row; null when idle. */
  draft: UIMessage | null;
  runStatus?: SessionRunStatus;
  onSessionRefresh?: () => void;
  /** Live View URL / running state from streamed testPreview tool output. */
  onAppTestStatus?: (
    status: import("@/lib/browser-run/run-status").AppTestLatestStatus | null,
  ) => void;
}

export function Chat({
  sessionId,
  messages,
  draft,
  runStatus = "idle",
  onSessionRefresh,
  onAppTestStatus,
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

  // After turn 1, runStatus stays "completed" until the next POST marks the
  // run running. isLiveChatTurn intentionally unlocks on terminal+streaming
  // (post-turn drain) — that same rule leaves the composer open for the whole
  // weak-network gap before runStatus flips. Lock optimistically on send.
  const [awaitingRunStart, setAwaitingRunStart] = useState(false);
  const leftReadyDuringAwaitRef = useRef(false);
  const lastSyncedPersistedRef = useRef("");

  useEffect(() => {
    if (!awaitingRunStart) {
      leftReadyDuringAwaitRef.current = false;
      return;
    }

    if (status === "submitted" || status === "streaming") {
      leftReadyDuringAwaitRef.current = true;
    }

    if (isActiveRunStatus(runStatus) || status === "error") {
      // Optimistic send lock: drop once the run projection or stream settles.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync lock to session/run status
      setAwaitingRunStart(false);
      return;
    }

    // Send failed or finished without ever projecting "running".
    if (leftReadyDuringAwaitRef.current && status === "ready") {
      setAwaitingRunStart(false);
    }
  }, [awaitingRunStart, runStatus, status]);

  const isLiveTurn = awaitingRunStart || isLiveChatTurn(status, runStatus);

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

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const trimmed = message.text.trim();
      if (!trimmed || isLiveTurn) {
        return;
      }

      setAwaitingRunStart(true);
      void sendMessage({ text: trimmed });
      onSessionRefresh?.();
    },
    [isLiveTurn, onSessionRefresh, sendMessage],
  );

  const handleRunAppTest = useCallback(() => {
    if (isLiveTurn) {
      return;
    }
    setAwaitingRunStart(true);
    void sendMessage({ text: APP_TEST_USER_PROMPT });
    onSessionRefresh?.();
  }, [isLiveTurn, onSessionRefresh, sendMessage]);

  const showStreamingIndicator =
    isLiveTurn &&
    !hasAssistantParts(displayMessages[displayMessages.length - 1]);

  // After the first completed turn only; hide while a turn is in flight.
  const showAppTestButton =
    !isLiveTurn &&
    displayMessages.some((message) => message.role === "assistant");

  const isStreaming =
    isLiveTurn && (status === "streaming" || status === "submitted");
  const submitStatus = isLiveTurn
    ? status === "streaming"
      ? "streaming"
      : status === "error"
        ? "error"
        : "submitted"
    : status === "error"
      ? "error"
      : "ready";

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

      <Conversation className="min-h-0">
        <ConversationContent className="gap-4 px-6 py-4">
          {displayMessages.length === 0 ? (
            <ConversationEmptyState
              description="例如：「创建一个待办事项应用,支持添加、完成和删除任务」"
              icon={<MessageSquare className="size-10" />}
              title="描述你想构建的 Next.js 应用"
            />
          ) : (
            displayMessages.map((message, index) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  <ChatMessageParts
                    isLastMessage={index === displayMessages.length - 1}
                    isStreaming={isStreaming}
                    message={message}
                  />
                </MessageContent>
              </Message>
            ))
          )}

          {showStreamingIndicator ? <Spinner /> : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              disabled={isLiveTurn}
              placeholder="描述你的 Next.js 应用需求…"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              {showAppTestButton ? (
                <PromptInputButton
                  disabled={isLiveTurn}
                  onClick={handleRunAppTest}
                  tooltip="Send a message asking the agent to run a happy-path UI test"
                >
                  <FlaskConical className="size-4" />
                  Auto Test
                </PromptInputButton>
              ) : null}
            </PromptInputTools>
            <PromptInputSubmit disabled={isLiveTurn} status={submitStatus} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
