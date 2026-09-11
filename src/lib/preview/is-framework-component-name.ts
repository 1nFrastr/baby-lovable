/**
 * Detect React / Next.js framework fibers that should not appear in
 * Visual Picker chip labels (or as stored componentName from the bridge).
 *
 * Prefer role-based suffixes over an ever-growing exact list so new App Router
 * wrappers (Context / Boundary / Router / …) stay filtered without another PR.
 *
 * Keep the starter bridge skip heuristic in
 * `templates/nextjs-starter/src/instrumentation-client.ts` aligned with this.
 */

/** Unwrap `ForwardRef(Foo)` / `Memo(Foo)` displayNames. */
export function unwrapComponentDisplayName(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = /^(?:ForwardRef|Memo)\((.+)\)$/.exec(trimmed);
  if (wrapped?.[1]) {
    return unwrapComponentDisplayName(wrapped[1]);
  }
  return trimmed.split(".").pop()?.trim() || trimmed;
}

/**
 * True when `name` is a React builtin or Next.js App Router / overlay fiber
 * rather than an app author component.
 */
export function isFrameworkComponentName(name: string): boolean {
  const trimmed = name.trim();
  const base = unwrapComponentDisplayName(trimmed);
  if (!base || base === "Anonymous" || base.startsWith("_")) {
    return true;
  }
  if (
    /^unstable_/.test(trimmed) ||
    /^unstable_/.test(base) ||
    /^Next\./.test(trimmed)
  ) {
    return true;
  }

  // React builtins + a few Next leaves that do not match the suffix rules.
  if (
    /^(Fragment|Suspense|StrictMode|Profiler|Provider|Consumer|Activity|ViewTransition|Lazy|Memo|ForwardRef|HotReload|HistoryUpdater|AppDevOverlay|ReactDevOverlay|RootErrorBoundary|ErrorBoundaryHandler|ClientSegmentRoot|ClientPageRoot|InnerScrollHandlerNew|ScrollAndMaybeFocusHandler|ScrollAndFocusHandler|RenderFromTemplateContext|SegmentViewNode|SegmentViewStateNode|SegmentBoundaryTriggerNode)$/.test(
      base,
    )
  ) {
    return true;
  }

  // Role suffixes used by React context/providers and Next route chrome.
  // (ThemeProvider / ErrorBoundary skip → walk to a real UI component or tag.)
  if (
    /(?:Boundary|Context|Provider|Consumer|Router|Portal|Outlet|Fallback|ViewNode|ViewStateNode|TriggerNode|FocusHandler)$/.test(
      base,
    )
  ) {
    return true;
  }

  // Next segment / navigation / hooks runtime names that slip past suffixes.
  if (
    /^(?:Segment|ClientSegment|ClientPage|LoadingBoundary|NavigationPromises|GlobalLayout|MissingSlot|Pathname|SearchParams|PathParams|HeadManager|ImageConfig|AppRouter|DevRoot|HTTPAccess)/.test(
      base,
    )
  ) {
    return true;
  }

  return false;
}

/** Component name safe to show on a pick chip / prompt line. */
export function usablePreviewComponentName(
  name: string | undefined,
): string | undefined {
  if (!name || isFrameworkComponentName(name)) {
    return undefined;
  }
  // Prefer PascalCase user components (skip minified single-letter names).
  const base = unwrapComponentDisplayName(name);
  if (!/^[A-Z]/.test(base)) {
    return undefined;
  }
  if (!/^[A-Z][A-Za-z0-9]*$/.test(base) && base.length < 3) {
    return undefined;
  }
  return base;
}
