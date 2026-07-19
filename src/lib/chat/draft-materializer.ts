import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import {
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { getRun } from "workflow/api";

import {
  createEmptyDraft,
  writeDraft,
  type SessionDraft,
} from "@/lib/session/draft-store";

const WRITE_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Consume UI chunks into a single assistant message (AI SDK readUIMessageStream). */
export async function consumeUiStreamToDraftMessage(
  stream: ReadableStream<UIMessageChunk>,
  seedMessage?: UIMessage,
): Promise<UIMessage> {
  let latest = seedMessage ?? createEmptyDraft("").message;

  for await (const message of readUIMessageStream({
    message: latest,
    stream,
  })) {
    latest = message;
  }

  return latest;
}

/**
 * Background task: read the durable workflow stream and overwrite `draft.json`
 * on each materialized update. Independent of the HTTP response lifecycle.
 */
export async function materializeDraftFromRun(
  sessionId: string,
  runId: string,
  userId: string | null = null,
): Promise<void> {
  const run = await getRun(runId);
  const uiStream = run
    .getReadable({ startIndex: 0 })
    .pipeThrough(createModelCallToUIChunkTransform());

  const messageStream = readUIMessageStream({
    message: createEmptyDraft(runId).message,
    stream: uiStream,
  });

  let lastWriteAt = 0;
  let pendingWrite: SessionDraft | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const flush = (draft: SessionDraft) => {
    pendingWrite = draft;
    // Always attach catch so a failed Supabase write cannot become an
    // unhandledRejection before the final await (fire-and-forget chain).
    writeChain = writeChain
      .catch(() => {
        // Prior write already logged; keep the chain alive for later drafts.
      })
      .then(async () => {
        const toWrite = pendingWrite;
        pendingWrite = null;
        if (!toWrite) {
          return;
        }
        try {
          await writeDraft(sessionId, toWrite, userId);
        } catch (error) {
          console.error(
            `[draft-materializer] session=${sessionId} run=${runId} write failed:`,
            error,
          );
        }
      });
  };

  try {
    for await (const message of messageStream) {
      const draft: SessionDraft = {
        runId,
        message,
        updatedAt: new Date().toISOString(),
      };

      const now = Date.now();
      if (now - lastWriteAt >= WRITE_INTERVAL_MS) {
        lastWriteAt = now;
        flush(draft);
      } else {
        pendingWrite = draft;
      }
    }

    if (pendingWrite) {
      flush(pendingWrite);
    }

    await writeChain;
  } catch (error) {
    console.error(
      `[draft-materializer] session=${sessionId} run=${runId} failed:`,
      error,
    );
    await writeChain.catch(() => {});
    throw error;
  }
}

/** Wait until draft file exists (used by tests). */
export async function waitForDraft(
  sessionId: string,
  timeoutMs = 10_000,
  userId: string | null = null,
): Promise<SessionDraft | null> {
  const deadline = Date.now() + timeoutMs;
  const { readDraft } = await import("@/lib/session/draft-store");

  while (Date.now() < deadline) {
    const draft = await readDraft(sessionId, userId);
    if (draft && draft.message.parts.length > 0) {
      return draft;
    }
    await sleep(200);
  }

  return readDraft(sessionId, userId);
}
