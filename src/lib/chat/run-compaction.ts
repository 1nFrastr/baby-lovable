import { convertToModelMessages, generateText, type UIMessage } from "ai";

import { DEFAULT_BUILDER_MODEL } from "@/lib/agent/builder-model";
import {
  CONTEXT_COMPACT_TOKENS,
  estimateTokens,
} from "@/lib/agent/context-compact";
import { formatTraceStdout } from "@/lib/agent/agent-trace";
import {
  buildCompactionUserPrompt,
  compactionNailId,
  COMPACTION_SYSTEM_PROMPT,
  createCompactionNail,
  createCompactionSummary,
  insertCompactionBefore,
  isCompactionMessage,
  isSummaryMessage,
  planCompaction,
  toPromptUiMessages,
} from "@/lib/chat/compaction";
import type { SessionAuthContext } from "@/lib/session/auth-context";

export type CompactionPersistMode = "turn" | "replace";

export type CompactSessionSuccess = {
  ok: true;
  messages: UIMessage[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
};

export type CompactSessionFailure = {
  ok: false;
  code: "not_enough_history" | "nothing_new" | "failed";
  error: string;
};

export type CompactSessionResult = CompactSessionSuccess | CompactSessionFailure;

async function estimatePromptTokens(
  sessionId: string,
  messages: UIMessage[],
): Promise<number> {
  try {
    const modelMessages = await convertToModelMessages(
      toPromptUiMessages(messages),
      { ignoreIncompleteToolCalls: true },
    );
    return estimateTokens(modelMessages);
  } catch (error) {
    console.log(
      formatTraceStdout(
        sessionId,
        "WARN",
        `compaction token estimate failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return Math.ceil(JSON.stringify(toPromptUiMessages(messages)).length / 4);
  }
}

export async function generateCompactionSummary(input: {
  head: UIMessage[];
  previousSummary?: string;
  guidance?: string;
}): Promise<string> {
  const modelId = process.env.AI_MODEL ?? DEFAULT_BUILDER_MODEL;
  const result = await generateText({
    model: modelId,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: buildCompactionUserPrompt(input),
    maxOutputTokens: 4_096,
  });
  return result.text.trim();
}

export async function compactSessionMessages(input: {
  sessionId: string;
  turnId: string;
  messages: UIMessage[];
  persistMode: CompactionPersistMode;
  force?: boolean;
  append?: boolean;
  guidance?: string;
  auth?: SessionAuthContext;
}): Promise<CompactSessionResult> {
  const { sessionId, turnId, persistMode } = input;
  const messages = input.messages;

  if (messages.some((message) => message.id === compactionNailId(turnId))) {
    return {
      ok: false,
      code: "nothing_new",
      error: "This conversation was already compacted for the current turn.",
    };
  }

  const estimatedTokensBefore = await estimatePromptTokens(sessionId, messages);
  if (!input.force && estimatedTokensBefore <= CONTEXT_COMPACT_TOKENS) {
    return {
      ok: false,
      code: "nothing_new",
      error: "Conversation is still under the compact budget.",
    };
  }

  const plan = planCompaction(messages);
  const headHasNewContent = plan.head.some(
    (message) => !isSummaryMessage(message) && !isCompactionMessage(message),
  );
  if (!plan.needed || !headHasNewContent) {
    return {
      ok: false,
      code: "not_enough_history",
      error: "Not enough conversation to summarize yet.",
    };
  }
  if (!input.append && !plan.currentUser) {
    return {
      ok: false,
      code: "not_enough_history",
      error: "Not enough conversation to summarize yet.",
    };
  }

  let text: string;
  try {
    text = await generateCompactionSummary({
      head: plan.head,
      previousSummary: plan.previousSummary,
      guidance: input.guidance,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Summarize failed";
    if (!input.force) {
      console.log(
        formatTraceStdout(
          sessionId,
          "WARN",
          `compaction summary failed; continuing with ephemeral compact: ${message}`,
        ),
      );
      return { ok: false, code: "failed", error: message };
    }
    return { ok: false, code: "failed", error: message };
  }

  if (!text) {
    return {
      ok: false,
      code: "failed",
      error: "The model returned an empty summary.",
    };
  }

  const nail = createCompactionNail({
    turnId,
    auto: !input.force,
    overflow: !input.force,
    tailStartId: plan.tailStartId,
  });
  const summary = createCompactionSummary({ turnId, text });
  const next = insertCompactionBefore(
    messages,
    input.append ? undefined : plan.currentUser?.id,
    nail,
    summary,
  );

  if (persistMode === "turn") {
    const { persistSessionCompaction } = await import(
      "@/lib/session/turn-store"
    );
    const beforeId = plan.currentUser?.id;
    if (beforeId) {
      const result = await persistSessionCompaction(
        sessionId,
        turnId,
        beforeId,
        nail,
        summary,
      );
      if (!result.ok) {
        console.log(
          formatTraceStdout(
            sessionId,
            "WARN",
            `compaction persist skipped (${result.reason}); prompt still uses in-memory nail`,
          ),
        );
      }
    }
  } else {
    const { replaceMessages } = await import("@/lib/session/store");
    await replaceMessages(sessionId, next, input.auth);
  }

  console.log(
    formatTraceStdout(
      sessionId,
      "INFO",
      `compacted history · tailStart=${plan.tailStartId ?? "none"} · head=${plan.head.length} · tail=${plan.tail.length}`,
    ),
  );

  return {
    ok: true,
    messages: next,
    estimatedTokensBefore,
    estimatedTokensAfter: await estimatePromptTokens(sessionId, next),
  };
}
