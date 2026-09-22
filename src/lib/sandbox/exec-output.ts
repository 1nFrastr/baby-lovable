/** Head+tail clip so long CLI output stays in context without keeping only the start. */

export const EXEC_STREAM_MAX_CHARS = 20_000;

export function clipHeadTail(
  text: string,
  maxChars = EXEC_STREAM_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const markerBudget = 80;
  const usable = Math.max(32, maxChars - markerBudget);
  const head = Math.floor(usable * 0.6);
  const tail = usable - head;
  const omitted = text.length - head - tail;

  return {
    text: `${text.slice(0, head)}\n…[truncated ${omitted} chars]…\n${text.slice(-tail)}`,
    truncated: true,
  };
}
