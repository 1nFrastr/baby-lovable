import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import {
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { getRun } from "workflow/api";

import {
  createAssistantPlaceholder,
  hasNewlyCompletedTool,
  lastAssistantMessage,
  mergeAssistantMonotonically,
  upsertAssistantInMessages,
} from "@/lib/chat/assistant-merge";

const TEXT_WRITE_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Consume UI chunks into a single assistant message (AI SDK readUIMessageStream). */
export async function consumeUiStreamToAssistantMessage(
  stream: ReadableStream<UIMessageChunk>,
  seedMessage: UIMessage,
): Promise<UIMessage> {
  let latest = seedMessage;

  for await (const message of readUIMessageStream({
    message: latest,
    stream,
  })) {
    latest = message;
  }

  return latest;
}

/**
 * Background task: read the durable workflow stream and upsert the in-flight
 * assistant into sessions.messages on each materialized update. Independent of
 * the HTTP response lifecycle.
 */
export async function materializeMessagesFromRun(
  sessionId: string,
  runId: string,
  assistantId: string,
  userId: string | null = null,
): Promise<void> {
  const run = await getRun(runId);
  const uiStream = run
    .getReadable({ startIndex: 0 })
    .pipeThrough(createModelCallToUIChunkTransform());

  const seed = createAssistantPlaceholder(assistantId);
  const messageStream = readUIMessageStream({
    message: seed,
    stream: uiStream,
  });

  let lastWriteAt = 0;
  let pendingAssistant: UIMessage | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let previousSnapshot = seed;

  const flush = (assistant: UIMessage, force = false) => {
    pendingAssistant = assistant;
    writeChain = writeChain
      .catch(() => {
        // Prior write already logged; keep the chain alive for later updates.
      })
      .then(async () => {
        const toWrite = pendingAssistant;
        pendingAssistant = null;
        if (!toWrite) {
          return;
        }

        try {
          const { getSession, replaceMessages } = await import(
            "@/lib/session/store"
          );
          const { isActiveRunStatus } = await import("@/lib/session/types");

          const session = await getSession(sessionId);
          if (
            !session ||
            !isActiveRunStatus(session.runStatus) ||
            session.lastRunId !== runId
          ) {
            return;
          }

          const existing = lastAssistantMessage(session.messages);
          const merged = existing
            ? mergeAssistantMonotonically(existing, {
                ...toWrite,
                id: existing.id,
              })
            : { ...toWrite, id: assistantId };

          const nextMessages = upsertAssistantInMessages(
            session.messages,
            merged,
          );
          await replaceMessages(sessionId, nextMessages, { userId });
        } catch (error) {
          console.error(
            `[message-materializer] session=${sessionId} run=${runId} write failed:`,
            error,
          );
        }
      });

    if (force) {
      lastWriteAt = Date.now();
    }
  };

  try {
    for await (const message of messageStream) {
      const assistant: UIMessage = { ...message, id: assistantId };
      const toolCompleted = hasNewlyCompletedTool(previousSnapshot, assistant);
      previousSnapshot = assistant;

      const now = Date.now();
      if (toolCompleted || now - lastWriteAt >= TEXT_WRITE_INTERVAL_MS) {
        lastWriteAt = now;
        flush(assistant, true);
      } else {
        pendingAssistant = assistant;
      }
    }

    if (pendingAssistant) {
      flush(pendingAssistant, true);
    }

    await writeChain;
  } catch (error) {
    console.error(
      `[message-materializer] session=${sessionId} run=${runId} failed:`,
      error,
    );
    await writeChain.catch(() => {});
    throw error;
  }
}

/** Wait until the authoritative assistant has parts (used by tests). */
export async function waitForAuthoritativeAssistant(
  sessionId: string,
  assistantId: string,
  timeoutMs = 10_000,
  userId: string | null = null,
): Promise<UIMessage | null> {
  const deadline = Date.now() + timeoutMs;
  const { getSession } = await import("@/lib/session/store");

  while (Date.now() < deadline) {
    const session = await getSession(sessionId, { userId });
    const assistant = session?.messages.find(
      (message) => message.id === assistantId,
    );
    if (assistant && assistant.parts.length > 0) {
      return assistant;
    }
    await sleep(200);
  }

  const session = await getSession(sessionId, { userId });
  return (
    session?.messages.find((message) => message.id === assistantId) ?? null
  );
}
