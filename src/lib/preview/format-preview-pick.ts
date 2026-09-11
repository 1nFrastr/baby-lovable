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

/**
 * Next.js / React framework fibers that leak into chip labels when picking
 * layout roots (e.g. SegmentViewNode · main). Kept in sync with the starter
 * bridge skip list so older sandboxes still render sane chips.
 */
const FRAMEWORK_COMPONENT_NAMES =
  /^(Fragment|Suspense|StrictMode|Profiler|Provider|Consumer|Activity|ViewTransition|SegmentViewNode|ClientSegmentRoot|OuterLayoutRouter|InnerLayoutRouter|RedirectBoundary|HTTPAccessFallbackBoundary|LoadingBoundary|NotFoundBoundary|DevRootHTTPAccessFallbackBoundary|ScrollAndFocusHandler|ScrollAndMaybeFocusHandler|RenderFromTemplateContext|AppRouter|HistoryUpdater|HotReload|ReactDevOverlay|AppDevOverlay|RootErrorBoundary|ErrorBoundaryHandler)$|Boundary$|LayoutRouter$/;

export function truncatePickText(value: string, max = MAX_SNIPPET): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function usableComponentName(name: string | undefined): string | undefined {
  if (!name || FRAMEWORK_COMPONENT_NAMES.test(name)) {
    return undefined;
  }
  return name;
}

/** `button:2` when the selector ends with nth-of-type; otherwise just the tag. */
function previewPickLeafName(pick: PreviewElementPickPayload): string {
  const nth = pick.selector.match(/:nth-of-type\((\d+)\)\s*$/i)?.[1];
  return nth ? `${pick.tagName}:${nth}` : pick.tagName;
}

/**
 * Short chip label: React component + DOM leaf (`TodoList · input`),
 * with optional nth index — not ids / aria / quoted text.
 */
export function previewPickChipLabel(pick: PreviewElementPickPayload): string {
  const leaf = previewPickLeafName(pick);
  const componentName = usableComponentName(pick.componentName);
  if (componentName) {
    return `${componentName} · ${leaf}`;
  }
  return leaf;
}

/** Tooltip / title with a bit more targeting context. */
export function previewPickChipTitle(pick: PreviewElementPickPayload): string {
  const componentName = usableComponentName(pick.componentName);
  const bits = [
    componentName ? `<${componentName}>` : null,
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
