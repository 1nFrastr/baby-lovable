"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { generateId, type UIMessage } from "ai";
import { FlaskConical, MessageSquare } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  clipSelectionToContainer,
  blurFocusOutside,
} from "@/lib/dom/clip-selection";
import { finalizeInterruptedMessages } from "@/lib/chat/interrupt-assistant";
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
  /** Sole persisted conversation read model. */
  messages: UIMessage[];
  conversationRevision: number;
  activeTurnId?: string;
  activeAssistantMessageId?: string;
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
  conversationRevision,
  activeTurnId,
  activeAssistantMessageId,
  runStatus = "idle",
  onSessionRefresh,
  onAppTestStatus,
}: ChatProps) {
  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: `/api/sessions/${sessionId}/chat`,
        maxConsecutiveErrors: 3,
        // Automatic reconnect is only for this mounted request and resumes
        // from its received chunk index. Fresh page mounts never call resume.
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
    onError: onSessionRefresh,
  });

  /**
   * When this page sends a turn, its one live useChat thread is the display.
   * A refreshed page has no local owner and is updated directly from the
   * authoritative session snapshots.
   */
  const [localUserMessageId, setLocalUserMessageId] = useState<string | null>(
    null,
  );
  const [pendingUserMessageId, setPendingUserMessageId] = useState<
    string | null
  >(null);
  const [stopping, setStopping] = useState(false);
  const [cancelledHint, setCancelledHint] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const lastSyncedRevisionRef = useRef(conversationRevision);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const serverTurnActive =
    (Boolean(activeTurnId) && isActiveRunStatus(runStatus)) ||
    (!activeTurnId && isActiveRunStatus(runStatus));
  const serverHasLocalUser =
    localUserMessageId != null &&
    messages.some((message) => message.id === localUserMessageId);

  useEffect(() => {
    if (!pendingUserMessageId) {
      return;
    }
    if (
      messages.some((message) => message.id === pendingUserMessageId) ||
      status === "error"
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- server acknowledged or rejected this send
      setPendingUserMessageId(null);
    }
  }, [messages, pendingUserMessageId, status]);

  useEffect(() => {
    if (localUserMessageId) {
      const terminalSnapshotReady =
        !serverTurnActive && serverHasLocalUser;
      const rejectedBeforeClaim =
        status === "error" && !serverTurnActive;
      if (!terminalSnapshotReady && !rejectedBeforeClaim) {
        return;
      }

      lastSyncedRevisionRef.current = conversationRevision;
      setMessages(messages);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hand display ownership back to authoritative snapshot
      setLocalUserMessageId(null);
      setPendingUserMessageId(null);
      return;
    }

    if (
      conversationRevision === lastSyncedRevisionRef.current
    ) {
      return;
    }
    lastSyncedRevisionRef.current = conversationRevision;
    setMessages(messages);
  }, [
    conversationRevision,
    localUserMessageId,
    messages,
    serverHasLocalUser,
    serverTurnActive,
    setMessages,
    status,
  ]);

  const composerLocked =
    stopping || Boolean(pendingUserMessageId) || serverTurnActive;
  const showStop =
    !stopping &&
    runStatus !== "cancelling" &&
    (serverTurnActive ||
      (localUserMessageId != null && status === "streaming"));
  const localStreamAnimating =
    localUserMessageId != null && status === "streaming";

  useEffect(() => {
    if (!onAppTestStatus) {
      return;
    }
    onAppTestStatus(extractAppTestStatusFromMessages(chatMessages));
  }, [chatMessages, onAppTestStatus]);

  const sendUserText = useCallback(
    (text: string) => {
      if (composerLocked) {
        return;
      }

      const userMessageId = generateId();
      setLocalUserMessageId(userMessageId);
      setPendingUserMessageId(userMessageId);
      setStopError(null);
      setCancelledHint(false);

      void sendMessage({
        id: userMessageId,
        role: "user",
        parts: [{ type: "text", text }],
      }).finally(() => {
        onSessionRefresh?.();
      });
      onSessionRefresh?.();
    },
    [composerLocked, onSessionRefresh, sendMessage],
  );

  useEffect(() => {
    let selectionStartedInTranscript = false;

    const onMouseDown = (event: MouseEvent) => {
      const transcript = transcriptRef.current;
      selectionStartedInTranscript = Boolean(
        transcript &&
          event.target instanceof Node &&
          transcript.contains(event.target),
      );
    };

    const clipTranscriptSelection = () => {
      const transcript = transcriptRef.current;
      if (transcript) {
        clipSelectionToContainer(transcript);
      }
    };

    const finishPointerSelection = () => {
      const transcript = transcriptRef.current;
      if (!transcript) {
        return;
      }
      clipSelectionToContainer(transcript);
      if (selectionStartedInTranscript) {
        blurFocusOutside(transcript);
      }
    };

    const finishAfterPointer = () => {
      finishPointerSelection();
      requestAnimationFrame(finishPointerSelection);
    };

    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("selectionchange", clipTranscriptSelection);
    document.addEventListener("mouseup", finishAfterPointer);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("selectionchange", clipTranscriptSelection);
      document.removeEventListener("mouseup", finishAfterPointer);
    };
  }, []);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const trimmed = message.text.trim();
      if (!trimmed) {
        return;
      }
      sendUserText(trimmed);
    },
    [sendUserText],
  );

  const handleRunAppTest = useCallback(() => {
    sendUserText(APP_TEST_USER_PROMPT);
  }, [sendUserText]);

  const handleStop = useCallback(() => {
    if (stopping || !showStop) {
      return;
    }

    setStopError(null);
    setStopping(true);

    const sealedMessages = finalizeInterruptedMessages(chatMessages);
    setMessages(sealedMessages);
    const lastAssistant = [...sealedMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          (!activeAssistantMessageId ||
            message.id === activeAssistantMessageId),
      );

    stop();

    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/chat/cancel`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              assistant: lastAssistant ?? null,
            }),
          },
        );
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            data?.error ?? `Stop failed (${response.status})`,
          );
        }

        setPendingUserMessageId(null);
        setCancelledHint(true);
        onSessionRefresh?.();
      } catch (cause) {
        setStopError(
          cause instanceof Error ? cause.message : "Stop failed",
        );
      } finally {
        setStopping(false);
      }
    })();
  }, [
    activeAssistantMessageId,
    chatMessages,
    onSessionRefresh,
    sessionId,
    setMessages,
    showStop,
    stop,
    stopping,
  ]);

  const activityLabel = resolveChatActivityLabel({
    live: (serverTurnActive || Boolean(pendingUserMessageId)) && !stopping,
    lastMessage: chatMessages[chatMessages.length - 1],
  });
  const lastDisplayMessage = chatMessages[chatMessages.length - 1];
  const showStandaloneActivity =
    Boolean(activityLabel) &&
    (!lastDisplayMessage || lastDisplayMessage.role === "user");

  const showAppTestButton =
    !composerLocked &&
    chatMessages.some((message) => message.role === "assistant");

  const submitStatus = stopping || showStop
    ? "streaming"
    : status === "error"
      ? "error"
      : pendingUserMessageId
        ? "submitted"
        : "ready";
  const composerPlaceholder = stopping
    ? "Stopping… you can send again after cancel succeeds"
    : "Describe the app you want to build…";
  const sessionStatusHint = stopping || runStatus === "cancelling"
    ? " - Stopping…"
    : showStop
      ? " - Generating…"
      : pendingUserMessageId
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

      <div className="flex min-h-0 flex-1 flex-col" ref={transcriptRef}>
        <Conversation className="min-h-0">
          <ConversationContent className="gap-4 px-6 py-4">
            {chatMessages.length === 0 ? (
              <ConversationEmptyState
                icon={<MessageSquare className="size-10" />}
                title="Describe the app you want to build"
                description=""
              />
            ) : (
              chatMessages.map((message, index) => {
                const isLast = index === chatMessages.length - 1;
                const messageActivityLabel =
                  isLast && message.role === "assistant"
                    ? activityLabel
                    : null;

                return (
                  <Message from={message.role} key={message.id}>
                    <MessageContent>
                      <ChatMessageParts
                        activityLabel={messageActivityLabel}
                        isLastMessage={isLast}
                        isStreaming={localStreamAnimating}
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
      </div>

      <div className="select-none border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
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
                  disabled={composerLocked}
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
