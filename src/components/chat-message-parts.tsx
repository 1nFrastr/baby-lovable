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
import { ChatActivityLabel } from "@/components/chat-activity-label";
import { UserMessagePreviewPickChips } from "@/components/preview-pick-chips";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { isRasterImageMediaType, attachmentDisplayUrl } from "@/lib/chat/attachments";
import {
  compactToolInput,
  formatToolPartLabel,
  formatToolPartOutput,
} from "@/lib/chat/format-tool-label";
import { truncateReasoningText } from "@/lib/chat/reasoning-text";
import { joinReasoningText } from "@/lib/chat/turn-progress";
import {
  USER_MESSAGE_IMAGE_FRAME_CLASS,
  USER_MESSAGE_IMAGE_TILE_CLASS,
} from "@/lib/chat/user-message-gallery";
import { collectPreviewPickParts } from "@/lib/preview/format-preview-pick";
import { cn } from "@/lib/utils";
import {
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { ChevronLeftIcon, ChevronRightIcon, FileIcon } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/** ~6 lines of text-sm; long user prompts stay collapsed until expanded. */
const USER_MESSAGE_COLLAPSE_CLASS = "max-h-36 overflow-hidden";

function collectTextParts(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function UserMessageText({ text }: { text: string }) {
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }

    const measure = () => {
      if (expanded) {
        return;
      }
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="min-w-0">
      <div className="relative">
        <p
          className={cn(
            "whitespace-pre-wrap break-words",
            !expanded && USER_MESSAGE_COLLAPSE_CLASS,
          )}
          ref={contentRef}
        >
          {text}
        </p>
        {overflows && !expanded ? (
          <button
            aria-expanded={false}
            className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-secondary from-35% to-transparent pt-8 text-left text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            onClick={() => setExpanded(true)}
            type="button"
          >
            Show more
          </button>
        ) : null}
      </div>
      {overflows && expanded ? (
        <button
          aria-expanded={true}
          className="mt-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          onClick={() => setExpanded(false)}
          type="button"
        >
          Show less
        </button>
      ) : null}
    </div>
  );
}

type UserFilePart = Extract<UIMessage["parts"][number], { type: "file" }>;

type PreviewImage = {
  key: string;
  label: string;
  src: string;
};

function UserMessageFiles({
  sessionId,
  parts,
}: {
  sessionId: string;
  parts: UIMessage["parts"];
}) {
  const files = parts.filter(
    (part): part is UserFilePart => part.type === "file",
  );
  const [failedKeys, setFailedKeys] = useState<Set<string>>(() => new Set());
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const classified = useMemo(() => {
    const images: PreviewImage[] = [];
    const documents: UserFilePart[] = [];
    files.forEach((file, index) => {
      const key = `${file.url}-${index}`;
      const src = attachmentDisplayUrl(sessionId, file.url);
      if (
        src &&
        isRasterImageMediaType(file.mediaType) &&
        !failedKeys.has(key)
      ) {
        images.push({
          key,
          label: file.filename?.trim() || "Attached image",
          src,
        });
        return;
      }
      documents.push(file);
    });
    return { documents, images };
  }, [failedKeys, files, sessionId]);

  const markFailed = useCallback((key: string) => {
    setFailedKeys((prev) => {
      if (prev.has(key)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {classified.images.length > 0 ? (
        <UserMessageImageGallery
          images={classified.images}
          onFail={markFailed}
          onOpen={setPreviewIndex}
        />
      ) : null}
      {classified.documents.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {classified.documents.map((file, index) => (
            <UserMessageFileChip
              file={file}
              key={`${file.filename ?? "file"}-${index}`}
              sessionId={sessionId}
            />
          ))}
        </div>
      ) : null}
      <UserMessageImagePreview
        images={classified.images}
        onClose={() => setPreviewIndex(null)}
        onIndexChange={setPreviewIndex}
        previewIndex={previewIndex}
      />
    </div>
  );
}

function UserMessageImageGallery({
  images,
  onFail,
  onOpen,
}: {
  images: PreviewImage[];
  onFail: (key: string) => void;
  onOpen: (index: number) => void;
}) {
  return (
    <div className={USER_MESSAGE_IMAGE_FRAME_CLASS}>
      {images.map((image, index) => (
        <button
          aria-label={`View ${image.label}`}
          className={cn("relative block", USER_MESSAGE_IMAGE_TILE_CLASS)}
          key={image.key}
          onClick={() => onOpen(index)}
          type="button"
        >
          {/* Stored attachments are served by the session-scoped host API. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={image.label}
            className="size-full object-cover"
            onError={() => onFail(image.key)}
            src={image.src}
          />
        </button>
      ))}
    </div>
  );
}

function UserMessageImagePreview({
  images,
  previewIndex,
  onClose,
  onIndexChange,
}: {
  images: PreviewImage[];
  previewIndex: number | null;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const current =
    previewIndex != null ? images[previewIndex] : undefined;
  const open = Boolean(current);
  const hasSeveral = images.length > 1;

  const go = useCallback(
    (direction: -1 | 1) => {
      if (previewIndex == null || images.length === 0) {
        return;
      }
      const next =
        (previewIndex + direction + images.length) % images.length;
      onIndexChange(next);
    },
    [images.length, onIndexChange, previewIndex],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
      }
    },
    [go],
  );

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className="max-h-[90vh] w-fit max-w-[min(96vw,52rem)] gap-3 overflow-hidden p-3 sm:max-w-[min(96vw,52rem)]"
        onKeyDown={hasSeveral ? handleKeyDown : undefined}
      >
        <DialogTitle className="truncate pr-8 text-sm">
          {current?.label ?? "Image"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {hasSeveral && previewIndex != null
            ? `Image ${previewIndex + 1} of ${images.length}`
            : "Attached image preview"}
        </DialogDescription>
        {current ? (
          <div className="relative flex items-center justify-center">
            {/* Stored attachments are served by the session-scoped host API. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={current.label}
              className="max-h-[min(75vh,40rem)] w-auto max-w-full object-contain"
              src={current.src}
            />
            {hasSeveral ? (
              <>
                <button
                  aria-label="Previous image"
                  className="absolute left-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white"
                  onClick={() => go(-1)}
                  type="button"
                >
                  <ChevronLeftIcon className="size-4" />
                </button>
                <button
                  aria-label="Next image"
                  className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white"
                  onClick={() => go(1)}
                  type="button"
                >
                  <ChevronRightIcon className="size-4" />
                </button>
                <p className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
                  {previewIndex != null ? previewIndex + 1 : 0} / {images.length}
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UserMessageFileChip({
  sessionId,
  file,
}: {
  sessionId: string;
  file: UserFilePart;
}) {
  const label = file.filename?.trim() || "Attached file";
  const src = attachmentDisplayUrl(sessionId, file.url);

  const chip = (
    <div className="flex max-w-full items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900/60">
      <FileIcon className="size-3.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 truncate">{label}</span>
      {!src ? (
        <span className="shrink-0 text-zinc-400">unavailable</span>
      ) : null}
    </div>
  );

  if (!src) {
    return chip;
  }

  return (
    <a
      className="max-w-full"
      download={file.filename ?? undefined}
      href={src}
      rel="noreferrer"
    >
      {chip}
    </a>
  );
}

function BuilderToolPart({
  part,
}: {
  part: ToolUIPart | DynamicToolUIPart;
}) {
  const outputLine = formatToolPartOutput(part);
  const errorText = "errorText" in part ? part.errorText : undefined;

  return (
    <Tool defaultOpen={false}>
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
  const reasoningText = truncateReasoningText(joinReasoningText(parts));

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
  activityLabel,
  sessionId,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  /** Idle planning label; rendered in the same column/gap as tool rows. */
  activityLabel?: string | null;
  sessionId: string;
}) {
  if (message.role === "user") {
    const text = collectTextParts(message);
    const picks = collectPreviewPickParts(message.parts).map((part) => ({
      ...part.data,
      id: part.id,
    }));
    return (
      <div className="flex flex-col gap-2">
        <UserMessagePreviewPickChips picks={picks} />
        <UserMessageFiles parts={message.parts} sessionId={sessionId} />
        {text ? <UserMessageText text={text} /> : null}
      </div>
    );
  }

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

    const isTrailing =
      reasoningRun.startIndex + reasoningRun.parts.length - 1 ===
      lastPartIndex;
    const isGroupStreaming =
      isLastMessage &&
      isStreaming &&
      (isTrailing ||
        reasoningRun.parts.some((part) => part.state === "streaming"));

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
        <BuilderToolPart
          key={`${message.id}-tool-${part.toolCallId}`}
          part={part}
        />,
      );
    }
    // data-compaction and other non-renderable parts are ignored.
  });

  flushReasoning();

  if (activityLabel) {
    nodes.push(
      <ChatActivityLabel key={`${message.id}-activity`} label={activityLabel} />,
    );
  }

  return <div className="flex flex-col gap-0.5">{nodes}</div>;
}
