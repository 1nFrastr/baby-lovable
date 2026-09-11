import {
  isPreviewPickPart,
  PREVIEW_PICK_PART_TYPE,
  type PreviewElementPickPayload,
  type PreviewPickUIPart,
} from "@/lib/preview/bridge-protocol";

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

/**
 * Short semantic label for chips (Cursor-style): prefer React component name,
 * then accessible / visible text — not raw CSS selectors.
 */
export function previewPickChipLabel(pick: PreviewElementPickPayload): string {
  if (pick.componentName) {
    return pick.componentName;
  }
  if (pick.ariaLabel) {
    return `${pick.tagName} “${truncatePickText(pick.ariaLabel, 28)}”`;
  }
  if (pick.textSnippet) {
    return `${pick.tagName} “${truncatePickText(pick.textSnippet, 28)}”`;
  }
  if (pick.testId) {
    return `${pick.tagName}[${truncatePickText(pick.testId, 24)}]`;
  }
  if (pick.id) {
    return `${pick.tagName}#${truncatePickText(pick.id, 24)}`;
  }
  return pick.tagName;
}

/** Tooltip / title with a bit more targeting context. */
export function previewPickChipTitle(pick: PreviewElementPickPayload): string {
  const bits = [
    pick.componentName ? `<${pick.componentName}>` : null,
    pick.tagName,
    pick.path,
    pick.selector,
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * Model-facing targeting text (not shown in the chat bubble UI).
 */
export function formatPreviewPicksForPrompt(
  picks: PreviewElementPickPayload[],
): string {
  if (picks.length === 0) {
    return "";
  }

  const lines = picks.map((pick, index) => {
    const details: string[] = [];
    if (pick.componentName) {
      details.push(`component \`${pick.componentName}\``);
    }
    details.push(`\`${pick.selector}\``);
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

/** @deprecated Prefer data-preview-pick parts; kept for tests / migration. */
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

export function toPreviewPickUIPart(
  pick: PreviewElementPickPayload,
  id?: string,
): PreviewPickUIPart {
  const { ...data } = pick;
  return {
    type: PREVIEW_PICK_PART_TYPE,
    id,
    data,
  };
}

export function collectPreviewPickParts(
  parts: ReadonlyArray<{ type: string }>,
): PreviewPickUIPart[] {
  return parts.filter(isPreviewPickPart);
}
