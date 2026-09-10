import type { PreviewElementPickPayload } from "@/lib/preview/bridge-protocol";

/** Composer / chat chip for a preview DOM pick (pick-to-chat). */
export interface PreviewElementPick extends PreviewElementPickPayload {
  /** Local id for chip remove; not sent to the model. */
  id: string;
}

const MAX_SNIPPET = 80;

export function truncatePickText(value: string, max = MAX_SNIPPET): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

/** Short label for the composer chip. */
export function previewPickChipLabel(pick: PreviewElementPickPayload): string {
  if (pick.testId) {
    return `[data-testid="${truncatePickText(pick.testId, 32)}"]`;
  }
  if (pick.id) {
    return `#${truncatePickText(pick.id, 40)}`;
  }
  if (pick.ariaLabel) {
    return `${pick.tagName}[aria-label="${truncatePickText(pick.ariaLabel, 28)}"]`;
  }
  if (pick.textSnippet) {
    return `${pick.tagName} “${truncatePickText(pick.textSnippet, 28)}”`;
  }
  return pick.selector.length <= 48
    ? pick.selector
    : `${pick.selector.slice(0, 47)}…`;
}

/**
 * Serialize picks into user message text so the agent sees edit targets
 * without a new UIMessage part type / Storage path.
 */
export function formatPreviewPicksForPrompt(
  picks: PreviewElementPickPayload[],
): string {
  if (picks.length === 0) {
    return "";
  }

  const lines = picks.map((pick, index) => {
    const details: string[] = [`\`${pick.selector}\``];
    if (pick.ariaLabel) {
      details.push(`aria-label "${truncatePickText(pick.ariaLabel)}"`);
    }
    if (pick.textSnippet) {
      details.push(`text "${truncatePickText(pick.textSnippet)}"`);
    }
    if (pick.className) {
      details.push(`class "${truncatePickText(pick.className, 60)}"`);
    }
    return `${index + 1}. <${pick.tagName}> on \`${pick.path}\` — ${details.join("; ")}`;
  });

  return [
    "Selected in preview (edit these targets; use searchContent / readFile to find matching JSX):",
    ...lines,
  ].join("\n");
}

export function mergeTextWithPreviewPicks(
  text: string,
  picks: PreviewElementPickPayload[],
): string {
  const pickBlock = formatPreviewPicksForPrompt(picks);
  const trimmed = text.trim();
  if (!pickBlock) {
    return trimmed;
  }
  if (!trimmed) {
    return pickBlock;
  }
  return `${pickBlock}\n\n${trimmed}`;
}
