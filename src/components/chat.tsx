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
  isComposerLocked,
  shouldReleaseComposerAfterStop,
} from "@/lib/chat/composer-lock";
import {
  hasAssistantParts,
  mergeDisplayMessages,
  persistedMessagesLagChat,
} from "@/lib/chat/merge-messages";
import {
  isActiveRunStatus,
  type SessionRunStatus,
} from "@/lib/session/types";

/** Sent when the user clicks Auto Test in the composer. */
const APP_TEST_USER_PROMPT =
  "Please run a quick happy-path UI test of the main flow.";

/** Cap streamed UI updates so long reasoning/markdown does not trip React #185. */
const CHAT_STREAM_THROTTLE_MS = 50;

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
    stop,
  } = useChat({
    id: sessionId,
    transport,
    messages,
    throttle: CHAT_STREAM_THROTTLE_MS,
    onError: () => {
      onSessionRefresh?.();
    },
  });

  // After turn 1, runStatus stays "completed" until the next POST marks the
  // run running. isLiveChatTurn intentionally unlocks on terminal+streaming
  // (post-turn drain) — that same rule leaves the composer open for the whole
  // weak-network gap before runStatus flips. Lock optimistically on send.
  const [awaitingRunStart, setAwaitingRunStart] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [cancelSucceeded, setCancelSucceeded] = useState(false);
  const [cancelledHint, setCancelledHint] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const leftReadyDuringAwaitRef = useRef(false);
  const lastSyncedPersistedRef = useRef("");
  const observedActiveRunRef = useRef(false);

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

  useEffect(() => {
    if (stopping && isActiveRunStatus(runStatus)) {
      observedActiveRunRef.current = true;
    }
  }, [runStatus, stopping]);

  useEffect(() => {
    if (
      !shouldReleaseComposerAfterStop({
        cancelSucceeded,
        runStatus,
        observedActiveRun: observedActiveRunRef.current,
      })
    ) {
      return;
    }
    observedActiveRunRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- unlock only after cancel is confirmed
    setStopping(false);
    setCancelSucceeded(false);
    setCancelledHint(true);
  }, [cancelSucceeded, runStatus]);

  const composerLocked = isComposerLocked({
    stopping,
    awaitingRunStart,
    chatStatus: status,
    runStatus,
  });
  const isLiveTurn = composerLocked;

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
      if (!trimmed || composerLocked) {
        return;
      }

      setAwaitingRunStart(true);
      setStopError(null);
      setCancelSucceeded(false);
      setCancelledHint(false);
      void sendMessage({ text: trimmed });
      onSessionRefresh?.();
    },
    [composerLocked, onSessionRefresh, sendMessage],
  );

  const handleRunAppTest = useCallback(() => {
    if (composerLocked) {
      return;
    }
    setAwaitingRunStart(true);
    setStopError(null);
    setCancelSucceeded(false);
    setCancelledHint(false);
    void sendMessage({ text: APP_TEST_USER_PROMPT });
    onSessionRefresh?.();
  }, [composerLocked, onSessionRefresh, sendMessage]);

  const handleStop = useCallback(() => {
    if (stopping || !composerLocked) {
      return;
    }

    setStopError(null);
    setCancelSucceeded(false);
    observedActiveRunRef.current = isActiveRunStatus(runStatus);
    setStopping(true);
    stop();

    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/chat/cancel`,
          { method: "POST" },
        );
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(data?.error ?? `Stop failed (${response.status})`);
        }
        setCancelSucceeded(true);
        setAwaitingRunStart(false);
        onSessionRefresh?.();
      } catch (cause) {
        setStopping(false);
        setCancelSucceeded(false);
        setStopError(
          cause instanceof Error ? cause.message : "Stop failed",
        );
      }
    })();
  }, [composerLocked, onSessionRefresh, runStatus, sessionId, stop, stopping]);

  const showStreamingIndicator =
    isLiveTurn &&
    !stopping &&
    !hasAssistantParts(displayMessages[displayMessages.length - 1]);

  // After the first completed turn only; hide while a turn is in flight.
  const showAppTestButton =
    !composerLocked &&
    displayMessages.some((message) => message.role === "assistant");

  const isStreaming =
    isLiveTurn &&
    !stopping &&
    (status === "streaming" || status === "submitted");
  const submitStatus = composerLocked
    ? status === "error"
      ? "error"
      : "streaming"
    : status === "error"
      ? "error"
      : "ready";
  const composerPlaceholder = stopping
    ? "正在停止，取消成功后即可发送…"
    : "描述你想构建的应用…";
  const sessionStatusHint = stopping
    ? " · 正在停止…"
    : composerLocked
      ? " · 正在生成…"
      : cancelledHint
        ? " · 已停止"
        : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Project Chat
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Session {sessionId}
          {sessionStatusHint}
          {error ? ` · ${error.message}` : ""}
          {stopError ? ` · ${stopError}` : ""}
        </p>
      </div>

      <Conversation className="min-h-0">
        <ConversationContent className="gap-4 px-6 py-4">
          {displayMessages.length === 0 ? (
            <ConversationEmptyState
              icon={<MessageSquare className="size-10" />}
              title="描述你想构建的应用"
              description=""
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
              aria-busy={composerLocked || undefined}
              className={
                composerLocked
                  ? "cursor-not-allowed text-muted-foreground"
                  : undefined
              }
              onKeyDown={(event) => {
                if (
                  composerLocked &&
                  event.key === "Enter" &&
                  !event.shiftKey
                ) {
                  event.preventDefault();
                }
              }}
              placeholder={composerPlaceholder}
              readOnly={composerLocked}
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
            <PromptInputSubmit
              onStop={handleStop}
              status={submitStatus}
              stopping={stopping}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
