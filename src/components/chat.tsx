"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { generateId, type FileUIPart, type UIMessage } from "ai";
import { FlaskConical, MessageSquare, Paperclip } from "lucide-react";
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
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { ChatActivityLabel } from "@/components/chat-activity-label";
import { ChatTimeline } from "@/components/chat-compaction";
import { PreviewPickChips } from "@/components/preview-pick-chips";
import { SlashCommandMenu } from "@/components/slash-command-menu";
import { useSlashCommandComposer } from "@/hooks/use-slash-command-composer";
import { resolveChatActivityLabel } from "@/lib/chat/activity-status";
import { extractAppTestStatusFromMessages } from "@/lib/chat/app-test-from-messages";
import {
  buildUserMessageParts,
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  uploadSessionAttachments,
} from "@/lib/chat/attachments";
import { finalizeInterruptedMessages } from "@/lib/chat/interrupt-assistant";
import type { SlashCommand } from "@/lib/chat/slash-commands";
import {
  mergeTextWithPreviewPicks,
  type PreviewElementPick,
} from "@/lib/preview/format-preview-pick";
import {
  isActiveRunStatus,
  type Session,
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
  /** Visual Picker chips from Preview (pick-to-chat). */
  previewPicks?: PreviewElementPick[];
  onRemovePreviewPick?: (id: string) => void;
  onClearPreviewPicks?: () => void;
  /** Exit Visual Picker when the composer is focused. */
  onComposerFocus?: () => void;
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
  previewPicks = [],
  onRemovePreviewPick,
  onClearPreviewPicks,
  onComposerFocus,
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
  const [summarizing, setSummarizing] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const submitInFlightRef = useRef(false);
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const lastSyncedRevisionRef = useRef(conversationRevision);

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

  const turnLocked =
    stopping ||
    summarizing ||
    Boolean(pendingUserMessageId) ||
    serverTurnActive;
  const composerLocked = turnLocked || uploadingAttachments;
  const slash = useSlashCommandComposer({
    disabled: composerLocked,
    surface: "web",
  });
  const {
    clear: clearSlash,
    resolveSubmit,
    setValue: setSlashValue,
    handleKeyDown: handleSlashKeyDown,
  } = slash;
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

  const sendUserMessage = useCallback(
    (text: string, files: FileUIPart[] = []) => {
      if (turnLocked) {
        return;
      }

      const parts = buildUserMessageParts(text, files);
      if (parts.length === 0) {
        return;
      }

      const userMessageId = generateId();
      setLocalUserMessageId(userMessageId);
      setPendingUserMessageId(userMessageId);
      setStopError(null);
      setCommandError(null);
      setCancelledHint(false);
      clearSlash();

      void sendMessage({
        id: userMessageId,
        role: "user",
        parts,
      }).finally(() => {
        onSessionRefresh?.();
      });
      onSessionRefresh?.();
    },
    [turnLocked, onSessionRefresh, sendMessage, clearSlash],
  );

  const runSlashCommand = useCallback(
    async (command: SlashCommand, args: string) => {
      if (composerLocked || command.name !== "summarize") {
        return;
      }

      setCommandError(null);
      setStopError(null);
      setSummarizing(true);
      clearSlash();

      try {
        const response = await fetch(`/api/sessions/${sessionId}/commands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: command.name, args }),
        });
        const data = (await response.json().catch(() => null)) as
          | {
              error?: string;
              session?: Session;
            }
          | null;
        if (!response.ok) {
          throw new Error(data?.error ?? `Command failed (${response.status})`);
        }
        if (data?.session?.messages) {
          lastSyncedRevisionRef.current = data.session.conversationRevision;
          setMessages(data.session.messages);
        }
        onSessionRefresh?.();
      } catch (cause) {
        setCommandError(
          cause instanceof Error ? cause.message : "Command failed",
        );
      } finally {
        setSummarizing(false);
      }
    },
    [clearSlash, composerLocked, onSessionRefresh, sessionId, setMessages],
  );

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (turnLocked || submitInFlightRef.current) {
        throw new Error("Composer is busy");
      }
      submitInFlightRef.current = true;

      try {
        const incoming = message.files ?? [];
        const parsed = resolveSubmit(message.text);
        if (parsed.kind === "empty") {
          if (incoming.length === 0 && previewPicks.length === 0) {
            return;
          }
        } else if (parsed.kind === "slash-draft") {
          return;
        } else if (parsed.kind === "unknown-command") {
          setCommandError(`Unknown command: /${parsed.name}`);
          throw new Error(`Unknown command: /${parsed.name}`);
        } else if (parsed.kind === "command") {
          void runSlashCommand(parsed.command, parsed.args);
          return;
        }

        if (incoming.length > 0) {
          setUploadingAttachments(true);
        }

        let files = incoming;
        if (incoming.length > 0) {
          files = await uploadSessionAttachments(sessionId, incoming);
          setCommandError(null);
        }

        const baseText = parsed.kind === "empty" ? "" : parsed.text;
        const text = mergeTextWithPreviewPicks(baseText, previewPicks);
        sendUserMessage(text, files);
        onClearPreviewPicks?.();
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message !== "Composer is busy"
        ) {
          setCommandError(cause.message);
        }
        throw cause;
      } finally {
        submitInFlightRef.current = false;
        setUploadingAttachments(false);
      }
    },
    [
      resolveSubmit,
      runSlashCommand,
      sendUserMessage,
      sessionId,
      turnLocked,
      previewPicks,
      onClearPreviewPicks,
    ],
  );

  const handleRunAppTest = useCallback(() => {
    sendUserMessage(APP_TEST_USER_PROMPT);
  }, [sendUserMessage]);

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
    live:
      (serverTurnActive ||
        Boolean(pendingUserMessageId) ||
        uploadingAttachments) &&
      !stopping,
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
      : summarizing || pendingUserMessageId || uploadingAttachments
        ? "submitted"
        : "ready";
  const composerPlaceholder = stopping
    ? "Stopping… you can send again after cancel succeeds"
    : summarizing
      ? "Summarizing conversation…"
      : "Describe the app, or paste / drop a screenshot";
  const sessionStatusHint = stopping || runStatus === "cancelling"
    ? " - Stopping…"
    : showStop
      ? " - Generating…"
      : pendingUserMessageId || uploadingAttachments
        ? " - Sending…"
        : cancelledHint
          ? " - Stopped"
          : "";

  return (
    <div className="relative flex h-full min-h-0 flex-col" ref={dropTargetRef}>
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
          {chatMessages.length === 0 ? (
            <ConversationEmptyState
              icon={<MessageSquare className="size-10" />}
              title="Describe the app you want to build"
              description="Paste or drop a screenshot, or attach files from the paperclip."
            />
          ) : (
            <ChatTimeline
              activityLabel={activityLabel}
              isStreaming={localStreamAnimating}
              messages={chatMessages}
              sessionId={sessionId}
            />
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
        <div className="relative">
          {slash.menuOpen ? (
            <SlashCommandMenu
              commands={slash.matches}
              highlight={slash.highlight}
              onHighlight={slash.setHighlight}
              onSelect={(command) => {
                void runSlashCommand(command, "");
              }}
            />
          ) : null}
          {commandError ? (
            <p
              className="mb-2 text-xs text-red-600 dark:text-red-400"
              role="alert"
            >
              {commandError}
            </p>
          ) : null}
          <PromptInput
            accept={CHAT_ATTACHMENT_ACCEPT}
            disabled={composerLocked}
            dropTargetRef={dropTargetRef}
            maxFileSize={CHAT_ATTACHMENT_MAX_BYTES}
            maxFiles={CHAT_ATTACHMENT_MAX_FILES}
            maxTotalFileSize={CHAT_ATTACHMENT_MAX_TOTAL_BYTES}
            multiple
            onError={(error) => setCommandError(error.message || null)}
            onSubmit={handleSubmit}
          >
            <PromptInputBody>
              {onRemovePreviewPick ? (
                <PreviewPickChips
                  picks={previewPicks}
                  onRemove={onRemovePreviewPick}
                />
              ) : null}
              <PromptInputAttachments>
                {(attachment) => (
                  <PromptInputAttachment data={attachment} />
                )}
              </PromptInputAttachments>
              <PromptInputTextarea
                aria-activedescendant={
                  slash.menuOpen && slash.highlighted
                    ? `slash-command-${slash.highlighted.name}`
                    : undefined
                }
                aria-busy={composerLocked || undefined}
                aria-controls={slash.menuOpen ? "slash-command-list" : undefined}
                aria-expanded={slash.menuOpen || undefined}
                aria-haspopup={slash.menuOpen ? "listbox" : undefined}
                className={
                  composerLocked
                    ? "cursor-not-allowed text-muted-foreground"
                    : undefined
                }
                onFocus={() => onComposerFocus?.()}
                onChange={(event) => setSlashValue(event.target.value)}
                onKeyDown={(event) => {
                  if (handleSlashKeyDown(event)) {
                    return;
                  }
                  if (
                    composerLocked &&
                    event.key === "Enter" &&
                    !event.shiftKey
                  ) {
                    event.preventDefault();
                    return;
                  }
                  if (
                    event.key === "Backspace" &&
                    event.currentTarget.value === "" &&
                    previewPicks.length > 0 &&
                    onRemovePreviewPick
                  ) {
                    event.preventDefault();
                    const last = previewPicks.at(-1);
                    if (last) {
                      onRemovePreviewPick(last.id);
                    }
                  }
                }}
                placeholder={composerPlaceholder}
                readOnly={composerLocked}
                role={slash.menuOpen ? "combobox" : undefined}
                value={slash.value}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <AttachFilesButton disabled={composerLocked} />
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
                disabled={composerLocked && !showStop}
                onStop={showStop ? handleStop : undefined}
                status={submitStatus}
                stopping={stopping}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}

function AttachFilesButton({ disabled }: { disabled: boolean }) {
  return (
    <PromptInputActionMenu>
      <PromptInputActionMenuTrigger
        aria-label="Attach images or documents"
        disabled={disabled}
        title="Attach images or documents"
      >
        <Paperclip className="size-4" />
      </PromptInputActionMenuTrigger>
      <PromptInputActionMenuContent>
        <PromptInputActionAddAttachments />
        <PromptInputActionAddScreenshot />
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  );
}
