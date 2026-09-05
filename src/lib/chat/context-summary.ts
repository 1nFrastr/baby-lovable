import type { UIMessage } from "ai";

export const CONTEXT_SUMMARY_KIND = "context-summary" as const;

export const CONTEXT_SUMMARY_HEADING =
  "Conversation summarized to free context.";

export interface ContextSummaryMetadata {
  kind: typeof CONTEXT_SUMMARY_KIND;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function isContextSummaryMessage(message: UIMessage): boolean {
  return (
    message.role === "assistant" &&
    isRecord(message.metadata) &&
    message.metadata.kind === CONTEXT_SUMMARY_KIND
  );
}
