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
import { ChatActivityLabel } from "@/components/chat-activity-label";
import { ChatMessageParts } from "@/components/chat-message-parts";
import { resolveChatActivityLabel } from "@/lib/chat/activity-status";
import { extractAppTestStatusFromMessages } from "@/lib/chat/app-test-from-messages";
import {
  finalizeInterruptedMessages,
  pickCancelledAssistantSnapshot,
} from "@/lib/chat/interrupt-assistant";
import {
  isComposerLocked,
  shouldReleaseComposerAfterStop,
  shouldShowStopControl,
} from "@/lib/chat/composer-lock";
import {
  mergeDisplayMessages,
} from "@/lib/chat/merge-messages";
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  type SessionRunStatus,
} from "@/lib/session/types";

/** Sent when the user clicks Auto Test in the composer. */
const APP_TEST_USER_PROMPT =
  "Please run a quick happy-path UI test of the main flow.";

/** Cap streamed UI updates so long reasoning/markdown does not trip React #185. */
const CHAT_STREAM_THROTTLE_MS = 50;

interface ChatProps {
  sessionId: string;
  /** Authoritative messages from the Supabase session row. */
  messages: UIMessage[];
  runStatus?: SessionRunStatus;
  /** updatedAt of the winning live runStatus source (session or projection). */
  runUpdatedAt?: string;
  onSessionRefresh?: () => void;
  /** Live View URL / running state from streamed testPreview tool output. */
  onAppTestStatus?: (
    status: import("@/lib/browser-run/run-status").AppTestLatestStatus | null,
  ) => void;
}

export function Chat({
  sessionId,
  messages,
  runStatus = "idle",
  runUpdatedAt = "",
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
  /** This mount observed submit/stream — distinguishes auto-finish from mid-run refresh. */
  const [sawLocalTransportBusy, setSawLocalTransportBusy] = useState(false);
  const leftReadyDuringAwaitRef = useRef(false);
  const awaitingSinceRef = useRef("");
  const lastSyncedPersistedRef = useRef("");
  const observedActiveRunRef = useRef(false);

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- latch local stream for refresh vs auto-finish
      setSawLocalTransportBusy(true);
    }
  }, [status]);

  useEffect(() => {
    if (!awaitingRunStart) {
      leftReadyDuringAwaitRef.current = false;
      awaitingSinceRef.current = "";
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

    // Server reported a fresh terminal after this send (Realtime may have
    // skipped pending/running). Do not treat the previous turn's completed
    // stamp as success — require updatedAt >= send time.
    if (
      isTerminalRunStatus(runStatus) &&
      runUpdatedAt &&
      awaitingSinceRef.current &&
      runUpdatedAt >= awaitingSinceRef.current
    ) {
      setAwaitingRunStart(false);
      return;
    }

    // Send failed or finished without ever projecting "running".
    if (leftReadyDuringAwaitRef.current && status === "ready") {
      setAwaitingRunStart(false);
    }
  }, [awaitingRunStart, runStatus, runUpdatedAt, status]);

  // Safety net: never leave the composer permanently locked if POST/run
  // projection never arrives (network error with status stuck on ready).
  useEffect(() => {
    if (!awaitingRunStart) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAwaitingRunStart(false);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [awaitingRunStart]);

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
    setStopping(false);
    setCancelSucceeded(false);
    setCancelledHint(true);
  }, [cancelSucceeded, runStatus]);

  // Mid-run refresh: transport remounts as ready while the server run continues.
  // Lock + authoritative message polling + Stop until runStatus goes terminal.
  const resumeActiveRun =
    isActiveRunStatus(runStatus) && !sawLocalTransportBusy;

  const composerLocked = isComposerLocked({
    stopping,
    awaitingRunStart,
    chatStatus: status,
    runStatus,
    resumeActiveRun,
  });
  // Draft recovery after refresh needs treatAsLive even before lock settles.
  const isLiveTurn = composerLocked || resumeActiveRun;
  const showStop = shouldShowStopControl({
    stopping,
    chatStatus: status,
    runStatus,
    resumeActiveRun,
  });

  // Only poll while we still need a server signal (early unlock / cancel /
  // mid-run authoritative refresh), not after the transport already finished.
  useEffect(() => {
    if (!onSessionRefresh) {
      return;
    }
    const needsReconcile =
      stopping ||
      resumeActiveRun ||
      (showStop && isActiveRunStatus(runStatus)) ||
      (awaitingRunStart && !isActiveRunStatus(runStatus));
    if (!needsReconcile) {
      return;
    }
    const timer = window.setInterval(() => {
      onSessionRefresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [
    awaitingRunStart,
    onSessionRefresh,
    resumeActiveRun,
    runStatus,
    showStop,
    stopping,
  ]);

  const displayMessages = useMemo(
    () =>
      mergeDisplayMessages(
        messages,
        chatMessages,
        isLiveTurn,
        stopping,
      ),
    [messages, chatMessages, isLiveTurn, stopping],
  );

  useEffect(() => {
    if (!onAppTestStatus) {
      return;
    }
    onAppTestStatus(extractAppTestStatusFromMessages(displayMessages));
  }, [displayMessages, onAppTestStatus]);

  // useChat only reads `messages` on mount; sync authoritative history between
  // turns so the next POST includes prior assistant replies.
  useEffect(() => {
    if (isLiveTurn) {
      return;
    }

    const fingerprint = messages.map((message) => message.id).join("|");
    if (fingerprint === lastSyncedPersistedRef.current) {
      return;
    }
    lastSyncedPersistedRef.current = fingerprint;

    setMessages(messages);
  }, [isLiveTurn, messages, setMessages]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const trimmed = message.text.trim();
      if (!trimmed || composerLocked) {
        return;
      }

      setAwaitingRunStart(true);
      awaitingSinceRef.current = new Date().toISOString();
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
    awaitingSinceRef.current = new Date().toISOString();
    setStopError(null);
    setCancelSucceeded(false);
    setCancelledHint(false);
    void sendMessage({ text: APP_TEST_USER_PROMPT });
    onSessionRefresh?.();
  }, [composerLocked, onSessionRefresh, sendMessage]);

  const handleStop = useCallback(() => {
    if (stopping || !showStop) {
      return;
    }

    setStopError(null);
    setCancelSucceeded(false);
    observedActiveRunRef.current = isActiveRunStatus(runStatus);
    setStopping(true);

    // Seal incomplete tools in the live thread immediately so "Editing…" cannot
    // linger while cancel + authoritative persist catch up.
    const sealedMessages = finalizeInterruptedMessages(chatMessages);
    setMessages(sealedMessages);
    const clientAssistant = pickCancelledAssistantSnapshot([
      sealedMessages.at(-1),
    ]);

    stop();

    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/chat/cancel`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assistant: clientAssistant }),
          },
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
  }, [
    chatMessages,
    onSessionRefresh,
    runStatus,
    sessionId,
    setMessages,
    showStop,
    stop,
    stopping,
  ]);

  // Cursor-style idle feedback inside the message column (same gap as tools).
  const activityLabel = resolveChatActivityLabel({
    live: isLiveTurn && !stopping,
    lastMessage: displayMessages[displayMessages.length - 1],
  });
  const lastDisplayMessage = displayMessages[displayMessages.length - 1];
  const showStandaloneActivity =
    Boolean(activityLabel) &&
    (!lastDisplayMessage || lastDisplayMessage.role === "user");

  // After the first completed turn only; hide while a turn is in flight.
  const showAppTestButton =
    !composerLocked &&
    displayMessages.some((message) => message.role === "assistant");

  const isStreaming = showStop;
  // Stop button only while generating; awaiting-send keeps textarea locked
  // without forcing a destructive Stop affordance.
  const submitStatus = stopping
    ? "streaming"
    : showStop
      ? "streaming"
      : status === "error"
        ? "error"
        : awaitingRunStart
          ? "submitted"
          : "ready";
  const composerPlaceholder = stopping
    ? "Stopping… you can send again after cancel succeeds"
    : "Describe the app you want to build…";
  const sessionStatusHint = stopping
    ? " - Stopping…"
    : showStop
      ? " - Generating…"
      : awaitingRunStart
        ? " - Sending…"
        : cancelledHint
          ? " - Stopped"
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
          {error ? ` - ${error.message}` : ""}
          {stopError ? ` - ${stopError}` : ""}
        </p>
      </div>

      <Conversation className="min-h-0">
        <ConversationContent className="gap-4 px-6 py-4">
          {displayMessages.length === 0 ? (
            <ConversationEmptyState
              icon={<MessageSquare className="size-10" />}
              title="Describe the app you want to build"
              description=""
            />
          ) : (
            displayMessages.map((message, index) => {
              const isLast = index === displayMessages.length - 1;
              const messageActivityLabel =
                isLast && message.role === "assistant" ? activityLabel : null;

              return (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    <ChatMessageParts
                      activityLabel={messageActivityLabel}
                      isLastMessage={isLast}
                      isStreaming={isStreaming}
                      message={message}
                    />
                  </MessageContent>
                </Message>
              );
            })
          )}

          {showStandaloneActivity && activityLabel ? (
            <Message from="assistant">
              <MessageContent>
                <div className="flex flex-col gap-0.5">
                  <ChatActivityLabel label={activityLabel} />
                </div>
              </MessageContent>
            </Message>
          ) : null}
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
              onStop={showStop ? handleStop : undefined}
              status={submitStatus}
              stopping={stopping}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
