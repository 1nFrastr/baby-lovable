/**
 * baby-lovable-preview-bridge
 * Platform-owned preview iframe bridge. Do not delete or rewrite this file —
 * the host Preview panel uses it for back/forward and the address-bar path.
 */

const SOURCE = "baby-lovable-preview" as const;
const REFRESH_PARAM = "__baby_lovable_refresh";

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

if (typeof window !== "undefined" && isInIframe()) {
  let entries: string[] = [cleanUrl(window.location.href).path];
  let index = 0;

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

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }
    const data = event.data as NavigatePayload | null;
    if (
      !data ||
      typeof data !== "object" ||
      data.source !== SOURCE ||
      data.type !== "navigate"
    ) {
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
