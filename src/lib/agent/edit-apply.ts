/**
 * Fuzzy string replacement for editFile, ported from OpenCode's replacer chain
 * (sourced there from Cline / Gemini CLI). Exact match first; later replacers
 * tolerate whitespace, indentation, escapes, and block-anchor drift.
 *
 * Successful replacements do not report which strategy matched.
 */

export type ApplyEditSuccess = {
  ok: true;
  content: string;
  replacements: number;
};

export type ApplyEditFailure = {
  ok: false;
  error: string;
  matches?: number;
};

export type ApplyEditResult = ApplyEditSuccess | ApplyEditFailure;

const NOT_FOUND_ERROR =
  "oldString was not found in the file. Re-read the file with readFile, copy the exact text (including whitespace), and retry editFile.";

const MULTIPLE_MATCHES_ERROR =
  "oldString matched multiple locations. Add surrounding context to make it unique, or set replaceAll to true.";

const DISPROPORTIONATE_ERROR =
  "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.";

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length);
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function sliceLines(
  content: string,
  originalLines: string[],
  startLine: number,
  endLine: number,
): string {
  let matchStartIndex = 0;
  for (let k = 0; k < startLine; k++) {
    matchStartIndex += originalLines[k].length + 1;
  }
  let matchEndIndex = matchStartIndex;
  for (let k = startLine; k <= endLine; k++) {
    matchEndIndex += originalLines[k].length;
    if (k < endLine) {
      matchEndIndex += 1;
    }
  }
  return content.substring(matchStartIndex, matchEndIndex);
}

function popTrailingEmpty(lines: string[]): string[] {
  if (lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) {
    return true;
  }
  if (oldLines === 1) {
    return false;
  }
  return (
    search.trim().length >
    Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
  );
}

const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = popTrailingEmpty(find.split("\n"));

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;

    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }

    if (matches) {
      yield sliceLines(content, originalLines, i, i + searchLines.length - 1);
    }
  }
};

const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = popTrailingEmpty(find.split("\n"));

  if (searchLines.length < 3) {
    return;
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue;
    }

    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1;
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j });
        }
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return;
  }

  const middleSimilarity = (
    startLine: number,
    endLine: number,
    average: boolean,
  ): number => {
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) {
      return 1;
    }

    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j].trim();
      const searchLine = searchLines[j].trim();
      const maxLen = Math.max(originalLine.length, searchLine.length);
      if (maxLen === 0) {
        continue;
      }
      const distance = levenshtein(originalLine, searchLine);
      const lineScore = 1 - distance / maxLen;
      if (average) {
        similarity += lineScore;
      } else {
        similarity += lineScore / linesToCheck;
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break;
        }
      }
    }
    return average ? similarity / linesToCheck : similarity;
  };

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    if (middleSimilarity(startLine, endLine, false) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield sliceLines(content, originalLines, startLine, endLine);
    }
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;

  for (const candidate of candidates) {
    const similarity = middleSimilarity(
      candidate.startLine,
      candidate.endLine,
      true,
    );
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    yield sliceLines(
      content,
      originalLines,
      bestMatch.startLine,
      bestMatch.endLine,
    );
  }
};

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);

  const lines = content.split("\n");
  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    } else {
      const normalizedLine = normalizeWhitespace(line);
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/);
        if (words.length > 0) {
          const pattern = words
            .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("\\s+");
          try {
            const match = line.match(new RegExp(pattern));
            if (match) {
              yield match[0];
            }
          } catch {
            // Invalid regex pattern, skip.
          }
        }
      }
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n");
      }
    }
  }
};

const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const textLines = text.split("\n");
    const nonEmptyLines = textLines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) {
      return text;
    }

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      }),
    );

    return textLines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join("\n");
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    });
  };

  const unescapedFind = unescapeString(find);

  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescapeString(block) === unescapedFind) {
      yield block;
    }
  }
};

const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();

  if (trimmedFind === find) {
    return;
  }

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = popTrailingEmpty(find.split("\n"));
  if (findLines.length < 3) {
    return;
  }

  const contentLines = content.split("\n");
  const firstLine = findLines[0].trim();
  const lastLine = findLines[findLines.length - 1].trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) {
      continue;
    }

    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== lastLine) {
        continue;
      }

      const blockLines = contentLines.slice(i, j + 1);
      const block = blockLines.join("\n");

      if (blockLines.length === findLines.length) {
        let matchingLines = 0;
        let totalNonEmptyLines = 0;

        for (let k = 1; k < blockLines.length - 1; k++) {
          const blockLine = blockLines[k].trim();
          const findLine = findLines[k].trim();

          if (blockLine.length > 0 || findLine.length > 0) {
            totalNonEmptyLines++;
            if (blockLine === findLine) {
              matchingLines++;
            }
          }
        }

        if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
          yield block;
        }
      }
      break;
    }
  }
};

const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0;

  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) {
      break;
    }
    yield find;
    startIndex = index + find.length;
  }
};

const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
];

function replaceOnContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ApplyEditResult {
  let foundNonUnique: string | undefined;

  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) {
        continue;
      }
      if (isDisproportionateMatch(search, oldString)) {
        return { ok: false, error: DISPROPORTIONATE_ERROR };
      }
      if (replaceAll) {
        return {
          ok: true,
          content: content.replaceAll(search, newString),
          replacements: countOccurrences(content, search),
        };
      }
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) {
        foundNonUnique = search;
        continue;
      }
      return {
        ok: true,
        content:
          content.substring(0, index) +
          newString +
          content.substring(index + search.length),
        replacements: 1,
      };
    }
  }

  if (foundNonUnique !== undefined) {
    return {
      ok: false,
      error: MULTIPLE_MATCHES_ERROR,
      matches: countOccurrences(content, foundNonUnique),
    };
  }

  return { ok: false, error: NOT_FOUND_ERROR };
}

/**
 * Apply a single oldString → newString replacement.
 * Line endings are normalized to the file's existing `\n` / `\r\n` style.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ApplyEditResult {
  if (oldString.length === 0) {
    return { ok: false, error: "oldString must not be empty" };
  }
  if (oldString === newString) {
    return {
      ok: false,
      error: "oldString and newString are identical; nothing to change",
    };
  }

  const usesCrlf = content.includes("\r\n");
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const normalizedOld = oldString.replace(/\r\n/g, "\n");
  const normalizedNew = newString.replace(/\r\n/g, "\n");

  if (normalizedOld === normalizedNew) {
    return {
      ok: false,
      error: "oldString and newString are identical; nothing to change",
    };
  }

  const result = replaceOnContent(
    normalizedContent,
    normalizedOld,
    normalizedNew,
    replaceAll,
  );
  if (!result.ok) {
    return result;
  }

  return {
    ...result,
    content: usesCrlf ? result.content.replace(/\n/g, "\r\n") : result.content,
  };
}
