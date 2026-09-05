import { convertToModelMessages, generateText, type UIMessage } from "ai";

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

export type CompactionPersistMode = "turn" | "replace";

async function exceedsCompactBudget(
  sessionId: string,
  messages: UIMessage[],
): Promise<boolean> {
  try {
    const modelMessages = await convertToModelMessages(
      toPromptUiMessages(messages),
      { ignoreIncompleteToolCalls: true },
    );
    return estimateTokens(modelMessages) > CONTEXT_COMPACT_TOKENS;
  } catch (error) {
    console.log(
      formatTraceStdout(
        sessionId,
        "WARN",
        `skipped compaction budget check: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return false;
  }
}

async function generateCompactionSummary(input: {
  head: UIMessage[];
  previousSummary?: string;
}): Promise<string> {
  const modelId = process.env.AI_MODEL ?? "deepseek/deepseek-v4-flash";
  const result = await generateText({
    model: modelId,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: buildCompactionUserPrompt(input),
    maxOutputTokens: 4_096,
  });
  return result.text.trim();
}

export async function ensureCompactionStep(
  sessionId: string,
  turnId: string,
  messages: UIMessage[],
  persistMode: CompactionPersistMode,
): Promise<UIMessage[]> {
  "use step";

  if (messages.some((message) => message.id === compactionNailId(turnId))) {
    return messages;
  }

  if (!(await exceedsCompactBudget(sessionId, messages))) {
    return messages;
  }

  const plan = planCompaction(messages);
  const headHasNewContent = plan.head.some(
    (message) => !isSummaryMessage(message) && !isCompactionMessage(message),
  );
  if (!plan.needed || !headHasNewContent || !plan.currentUser) {
    return messages;
  }

  let text: string;
  try {
    text = await generateCompactionSummary({
      head: plan.head,
      previousSummary: plan.previousSummary,
    });
  } catch (error) {
    console.log(
      formatTraceStdout(
        sessionId,
        "WARN",
        `compaction summary failed; continuing with ephemeral compact: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return messages;
  }

  if (!text) {
    return messages;
  }

  const nail = createCompactionNail({
    turnId,
    auto: true,
    overflow: true,
    tailStartId: plan.tailStartId,
  });
  const summary = createCompactionSummary({ turnId, text });
  const next = insertCompactionBefore(
    messages,
    plan.currentUser.id,
    nail,
    summary,
  );

  if (persistMode === "turn") {
    const { persistSessionCompaction } = await import(
      "@/lib/session/turn-store"
    );
    const result = await persistSessionCompaction(
      sessionId,
      turnId,
      plan.currentUser.id,
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
  } else {
    const { replaceMessages } = await import("@/lib/session/store");
    await replaceMessages(sessionId, next);
  }

  console.log(
    formatTraceStdout(
      sessionId,
      "INFO",
      `compacted history · tailStart=${plan.tailStartId ?? "none"} · head=${plan.head.length} · tail=${plan.tail.length}`,
    ),
  );

  return next;
}
