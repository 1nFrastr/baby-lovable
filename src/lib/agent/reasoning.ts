/** Portable AI SDK reasoning levels. DeepSeek maps medium→high; only low shortens it. */
export const REASONING_LEVELS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffort = (typeof REASONING_LEVELS)[number];

/** Default for the builder: start tool calls quickly instead of a long think. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

/**
 * Resolve reasoning effort. Override with AI_REASONING
 * (none | minimal | low | medium | high | xhigh | provider-default).
 */
export function resolveReasoningEffort(): ReasoningEffort {
  const raw = process.env.AI_REASONING?.trim().toLowerCase();
  if (raw && (REASONING_LEVELS as readonly string[]).includes(raw)) {
    return raw as ReasoningEffort;
  }
  return DEFAULT_REASONING_EFFORT;
}
