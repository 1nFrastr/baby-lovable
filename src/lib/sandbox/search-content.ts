import type { ContentSearchMatch } from "./types";
import { isProtectedPath } from "./protected-paths";

/** Cap matches returned to the model (prompt size). */
export const SEARCH_CONTENT_MAX_MATCHES = 50;

/** Truncate each matched line so one long line cannot flood the prompt. */
export const SEARCH_CONTENT_MAX_SNIPPET_CHARS = 200;

function truncateSnippet(snippet: string, maxChars: number): string {
  const trimmed = snippet.replace(/\s+$/, "");
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}…`;
}

/**
 * Filter protected paths, truncate snippets, and cap match count.
 * `totalMatches` is the count after protected-path filtering (before cap).
 */
export function boundContentMatches(
  matches: ContentSearchMatch[],
  options?: {
    maxMatches?: number;
    maxSnippetChars?: number;
  },
): {
  matches: ContentSearchMatch[];
  truncated: boolean;
  totalMatches: number;
} {
  const maxMatches = options?.maxMatches ?? SEARCH_CONTENT_MAX_MATCHES;
  const maxSnippetChars =
    options?.maxSnippetChars ?? SEARCH_CONTENT_MAX_SNIPPET_CHARS;

  const filtered = matches
    .filter((match) => !isProtectedPath(match.path))
    .map((match) => ({
      path: match.path,
      line: match.line,
      snippet: truncateSnippet(match.snippet, maxSnippetChars),
    }));

  const truncated = filtered.length > maxMatches;
  return {
    matches: truncated ? filtered.slice(0, maxMatches) : filtered,
    truncated,
    totalMatches: filtered.length,
  };
}
