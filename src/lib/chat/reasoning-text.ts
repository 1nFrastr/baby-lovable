/**
 * Cap reasoning shown in chat / persisted snapshots so a long think cannot
 * freeze the UI (React #185) or balloon session rows.
 */
export const REASONING_TEXT_MAX_CHARS = 4_000;

export function truncateReasoningText(text: string): string {
  if (text.length <= REASONING_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, REASONING_TEXT_MAX_CHARS).trimEnd()}…`;
}
