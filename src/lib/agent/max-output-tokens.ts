/** Global ceiling for per-step output (OpenCode-style default). */
export const OUTPUT_TOKEN_MAX = 32_000;

/** Known provider output limits; clamped to OUTPUT_TOKEN_MAX (or env override). */
const MODEL_OUTPUT_LIMITS: Record<string, number> = {
  "minimax/minimax-m3": 131_072,
};

/**
 * Resolve maxOutputTokens: min(provider limit, ceiling).
 * Ceiling defaults to 32k; override with AI_MAX_OUTPUT_TOKENS.
 */
export function resolveMaxOutputTokens(modelId: string): number {
  const envMax = Number(process.env.AI_MAX_OUTPUT_TOKENS);
  const ceiling =
    Number.isInteger(envMax) && envMax > 0 ? envMax : OUTPUT_TOKEN_MAX;

  const providerLimit = MODEL_OUTPUT_LIMITS[modelId];
  if (providerLimit != null && providerLimit > 0) {
    return Math.min(providerLimit, ceiling) || ceiling;
  }

  return ceiling;
}
