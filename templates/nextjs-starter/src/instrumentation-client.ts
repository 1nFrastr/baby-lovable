/**
 * baby-lovable-preview-bridge
 * Platform-owned preview iframe bridge. Do not delete or rewrite this file —
 * the host Preview panel uses it for back/forward, the address-bar path, and
 * Visual Picker (pick-to-chat).
 */

const SOURCE = "baby-lovable-preview" as const;
const REFRESH_PARAM = "__baby_lovable_refresh";
const HIGHLIGHT_Z = 2147483646;

type NavigateAction = "back" | "forward" | "reload" | "home";

interface LocationPayload {
  source: typeof SOURCE;
  type: "location";
  href: string;
  path: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface NavigatePayload {
  source: typeof SOURCE;
  type: "navigate";
  action: NavigateAction;
}

interface InspectPayload {
  source: typeof SOURCE;
  type: "inspect";
  enabled: boolean;
}

interface ElementPickedPayload {
  source: typeof SOURCE;
  type: "element-picked";
  element: {
    tagName: string;
    componentName?: string;
    id?: string;
    className?: string;
    textSnippet?: string;
    ariaLabel?: string;
    testId?: string;
    selector: string;
    path: string;
  };
}

function isInIframe(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

function cleanUrl(raw: string): { href: string; path: string } {
  try {
    const url = new URL(raw, window.location.origin);
    url.searchParams.delete(REFRESH_PARAM);
    const search = url.searchParams.toString();
    const path = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
    return { href: `${url.origin}${path}`, path: path || "/" };
  } catch {
    return { href: raw, path: raw };
  }
}

function pathFromHrefOrRelative(raw?: string | URL | null): string {
  if (raw == null || raw === "") {
    return cleanUrl(window.location.href).path;
  }
  return cleanUrl(String(raw)).path;
}

function cssEscapeIdent(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function ownTextSnippet(el: Element): string | undefined {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function nthOfTypeSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) {
    return tag;
  }
  const siblings = [...parent.children].filter(
    (child) => child.tagName === el.tagName,
  );
  if (siblings.length <= 1) {
    return tag;
  }
  const index = siblings.indexOf(el) + 1;
  return `${tag}:nth-of-type(${index})`;
}

/** React / Next internals — not useful as pick-to-chat chip names. */
const SKIP_COMPONENT_NAMES =
  /^(Fragment|Suspense|StrictMode|Profiler|Provider|Consumer|Activity|ViewTransition|SegmentViewNode|ClientSegmentRoot|OuterLayoutRouter|InnerLayoutRouter|RedirectBoundary|HTTPAccessFallbackBoundary|LoadingBoundary|NotFoundBoundary|DevRootHTTPAccessFallbackBoundary|ScrollAndFocusHandler|ScrollAndMaybeFocusHandler|RenderFromTemplateContext|AppRouter|HistoryUpdater|HotReload|ReactDevOverlay|AppDevOverlay|RootErrorBoundary|ErrorBoundaryHandler)$/;

function normalizeComponentName(raw: string): string | undefined {
  const name = raw.split(".").pop()?.trim();
  if (!name || name === "Anonymous" || name.startsWith("_")) {
    return undefined;
  }
  if (SKIP_COMPONENT_NAMES.test(name)) {
    return undefined;
  }
  // Next.js App Router / Flight wrappers often end with Boundary or Router.
  if (/(?:Boundary|LayoutRouter)$/.test(name)) {
    return undefined;
  }
  // Prefer PascalCase user components (skip minified single-letter names).
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name) && name.length < 3) {
    return undefined;
  }
  if (!/^[A-Z]/.test(name)) {
    return undefined;
  }
  return name;
}

function nameFromComponentType(type: unknown): string | undefined {
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return normalizeComponentName(fn.displayName || fn.name || "");
  }
  if (typeof type === "object" && type !== null) {
    const obj = type as {
      displayName?: string;
      render?: { displayName?: string; name?: string };
      type?: unknown;
    };
    const nested =
      obj.displayName ||
      obj.render?.displayName ||
      obj.render?.name ||
      "";
    const fromNested = normalizeComponentName(nested);
    if (fromNested) {
      return fromNested;
    }
    return nameFromComponentType(obj.type);
  }
  return undefined;
}

/**
 * Best-effort React fiber walk for a Cursor-style component node name.
 * Production minification may hide names — fall back to tag / text in the host.
 */
function resolveReactComponentName(el: Element): string | undefined {
  const fiberKey = Reflect.ownKeys(el).find((key) => {
    const name = typeof key === "string" ? key : "";
    return (
      name.startsWith("__reactFiber$") ||
      name.startsWith("__reactInternalInstance$")
    );
  });
  if (typeof fiberKey !== "string") {
    return undefined;
  }

  let fiber: { type?: unknown; return?: unknown } | null = (
    el as unknown as Record<string, { type?: unknown; return?: unknown }>
  )[fiberKey];

  for (let depth = 0; fiber && depth < 30; depth += 1) {
    const name = nameFromComponentType(fiber.type);
    if (name) {
      return name;
    }
    fiber = (fiber.return as typeof fiber) ?? null;
  }
  return undefined;
}

/** Best-effort unique-ish selector for the agent / chip label. */
function buildSelector(el: Element): string {
  const testId = el.getAttribute("data-testid");
  if (testId) {
    return `[data-testid="${cssEscapeIdent(testId)}"]`;
  }
  if (el.id) {
    return `#${cssEscapeIdent(el.id)}`;
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    return `${el.tagName.toLowerCase()}[aria-label="${cssEscapeIdent(ariaLabel)}"]`;
  }
  const name = el.getAttribute("name");
  if (name && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/i.test(el.tagName)) {
    return `${el.tagName.toLowerCase()}[name="${cssEscapeIdent(name)}"]`;
  }

  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node !== document.documentElement && depth < 5) {
    if (node.id) {
      parts.unshift(`#${cssEscapeIdent(node.id)}`);
      break;
    }
    const test = node.getAttribute("data-testid");
    if (test) {
      parts.unshift(`[data-testid="${cssEscapeIdent(test)}"]`);
      break;
    }
    parts.unshift(nthOfTypeSelector(node));
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

function describeElement(el: Element, path: string): ElementPickedPayload["element"] {
  const className =
    typeof el.className === "string"
      ? el.className.replace(/\s+/g, " ").trim().slice(0, 80) || undefined
      : undefined;
  const ariaLabel = el.getAttribute("aria-label")?.trim() || undefined;
  const testId = el.getAttribute("data-testid")?.trim() || undefined;
  const id = el.id?.trim() || undefined;
  const componentName = resolveReactComponentName(el);

  return {
    tagName: el.tagName.toLowerCase(),
    componentName,
    id,
    className,
    textSnippet: ownTextSnippet(el),
    ariaLabel,
    testId,
    selector: buildSelector(el),
    path,
  };
}

if (typeof window !== "undefined" && isInIframe()) {
  let entries: string[] = [cleanUrl(window.location.href).path];
  let index = 0;
  let inspectEnabled = false;
  let highlightEl: HTMLDivElement | null = null;
  let hoveredTarget: Element | null = null;

  const postLocation = (path = entries[index] ?? "/") => {
    const { href } = cleanUrl(path);
    const payload: LocationPayload = {
      source: SOURCE,
      type: "location",
      href,
      path,
      canGoBack: index > 0,
      canGoForward: index < entries.length - 1,
    };
    window.parent.postMessage(payload, "*");
  };

  const rememberPush = (path: string) => {
    entries = entries.slice(0, index + 1);
    entries.push(path);
    index = entries.length - 1;
    postLocation(path);
  };

  const rememberReplace = (path: string) => {
    entries[index] = path;
    postLocation(path);
  };

  const rememberTraverse = (path: string) => {
    if (index > 0 && entries[index - 1] === path) {
      index -= 1;
    } else if (index < entries.length - 1 && entries[index + 1] === path) {
      index += 1;
    } else {
      const found = entries.indexOf(path);
      if (found >= 0) {
        index = found;
      } else {
        entries = [path];
        index = 0;
      }
    }
    postLocation(path);
  };

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = ((data, unused, url) => {
    originalPushState(data, unused, url);
    rememberPush(pathFromHrefOrRelative(url));
  }) as History["pushState"];

  history.replaceState = ((data, unused, url) => {
    originalReplaceState(data, unused, url);
    rememberReplace(pathFromHrefOrRelative(url));
  }) as History["replaceState"];

  window.addEventListener("popstate", () => {
    rememberTraverse(cleanUrl(window.location.href).path);
  });

  const ensureHighlight = (): HTMLDivElement => {
    if (highlightEl && highlightEl.isConnected) {
      return highlightEl;
    }
    const box = document.createElement("div");
    box.setAttribute("data-baby-lovable-inspect", "highlight");
    box.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      `z-index:${HIGHLIGHT_Z}`,
      "border:2px solid #2563eb",
      "background:rgba(37,99,235,0.12)",
      "border-radius:2px",
      "display:none",
      "box-sizing:border-box",
    ].join(";");
    document.documentElement.appendChild(box);
    highlightEl = box;
    return box;
  };

  const hideHighlight = () => {
    if (highlightEl) {
      highlightEl.style.display = "none";
    }
    hoveredTarget = null;
  };

  const moveHighlight = (target: Element | null) => {
    if (!inspectEnabled || !target || target === document.documentElement) {
      hideHighlight();
      return;
    }
    if (
      target instanceof HTMLElement &&
      target.dataset.babyLovableInspect === "highlight"
    ) {
      return;
    }
    hoveredTarget = target;
    const rect = target.getBoundingClientRect();
    const box = ensureHighlight();
    box.style.display = "block";
    box.style.top = `${Math.max(0, rect.top)}px`;
    box.style.left = `${Math.max(0, rect.left)}px`;
    box.style.width = `${Math.max(0, rect.width)}px`;
    box.style.height = `${Math.max(0, rect.height)}px`;
  };

  const setInspectEnabled = (enabled: boolean) => {
    inspectEnabled = enabled;
    document.documentElement.style.cursor = enabled ? "crosshair" : "";
    if (!enabled) {
      hideHighlight();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!inspectEnabled) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      hideHighlight();
      return;
    }
    moveHighlight(target);
  };

  const onClickCapture = (event: MouseEvent) => {
    if (!inspectEnabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const target =
      hoveredTarget ??
      (event.target instanceof Element ? event.target : null);
    if (!target || target === document.documentElement) {
      return;
    }
    if (
      target instanceof HTMLElement &&
      target.dataset.babyLovableInspect === "highlight"
    ) {
      return;
    }

    const path = cleanUrl(window.location.href).path;
    const payload: ElementPickedPayload = {
      source: SOURCE,
      type: "element-picked",
      element: describeElement(target, path),
    };
    window.parent.postMessage(payload, "*");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!inspectEnabled) {
      return;
    }
    if (event.key === "Escape") {
      setInspectEnabled(false);
      window.parent.postMessage(
        { source: SOURCE, type: "inspect-state", enabled: false },
        "*",
      );
    }
  };

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("keydown", onKeyDown, true);

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }
    const data = event.data as NavigatePayload | InspectPayload | null;
    if (
      !data ||
      typeof data !== "object" ||
      data.source !== SOURCE
    ) {
      return;
    }

    if (data.type === "inspect" && typeof data.enabled === "boolean") {
      setInspectEnabled(data.enabled);
      return;
    }

    if (data.type !== "navigate") {
      return;
    }

    switch (data.action) {
      case "back":
        history.back();
        break;
      case "forward":
        history.forward();
        break;
      case "reload":
        window.location.reload();
        break;
      case "home":
        window.location.assign("/");
        break;
      default:
        break;
    }
  });

  postLocation();
}

export function onRouterTransitionStart(
  url: string,
  _navigationType: "push" | "replace" | "traverse",
): void {
  if (typeof window === "undefined" || !isInIframe()) {
    return;
  }

  try {
    const resolved =
      url.startsWith("http://") || url.startsWith("https://")
        ? url
        : new URL(url, window.location.origin).href;
    const { href, path } = cleanUrl(resolved);
    // Early path hint only — history hooks own canGo* after push/pop settles.
    window.parent.postMessage(
      {
        source: SOURCE,
        type: "location",
        href,
        path,
      },
      "*",
    );
  } catch {
    // ignore
  }
}
