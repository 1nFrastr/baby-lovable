import type { BrowserRunConfig } from "./config";

export interface BrowserRunSession {
  browserSessionId: string;
  webSocketDebuggerUrl: string;
  liveViewUrl: string;
}

interface CreateSessionTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl?: string;
}

interface CreateSessionPayload {
  sessionId?: string;
  webSocketDebuggerUrl?: string;
  targets?: CreateSessionTarget[];
}

function unwrapPayload(json: unknown): CreateSessionPayload {
  if (!json || typeof json !== "object") {
    return {};
  }
  const record = json as Record<string, unknown>;
  if (record.result && typeof record.result === "object") {
    return record.result as CreateSessionPayload;
  }
  return record as CreateSessionPayload;
}

/**
 * Prefer standalone tab view for human monitoring (not the full DevTools inspector).
 * @see https://developers.cloudflare.com/browser-run/features/live-view/
 */
export function toTabLiveViewUrl(devtoolsFrontendUrl: string): string {
  try {
    const url = new URL(devtoolsFrontendUrl);
    if (url.hostname === "live.browser.run") {
      url.pathname = "/ui/view";
      url.searchParams.set("mode", "tab");
      return url.toString();
    }
  } catch {
    // fall through
  }

  if (devtoolsFrontendUrl.includes("mode=")) {
    return devtoolsFrontendUrl.replace(/mode=[^&]+/, "mode=tab");
  }

  const sep = devtoolsFrontendUrl.includes("?") ? "&" : "?";
  return `${devtoolsFrontendUrl}${sep}mode=tab`;
}

export async function createBrowserRunSession(
  config: BrowserRunConfig,
  keepAliveMs = 600_000,
): Promise<BrowserRunSession> {
  const endpoint = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/browser-rendering/devtools/browser`,
  );
  endpoint.searchParams.set("keep_alive", String(keepAliveMs));
  endpoint.searchParams.set("targets", "true");

  const maxAttempts = 4;
  let lastError = "Browser Run create session failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
      },
    });

    const rawText = await response.text();

    if (response.status === 429) {
      lastError = `Browser Run rate limited (429): ${rawText.slice(0, 200)}`;
      const waitMs = Math.min(attempt * 5_000, 15_000);
      console.warn(
        `[browser-run] 429 rate limit — retry ${attempt}/${maxAttempts} in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText) as unknown;
    } catch {
      throw new Error(
        `Browser Run create session returned non-JSON (${response.status}): ${rawText.slice(0, 300)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Browser Run create session failed (${response.status}): ${rawText.slice(0, 500)}`,
      );
    }

    const payload = unwrapPayload(json);
    const webSocketDebuggerUrl = payload.webSocketDebuggerUrl;
    if (!webSocketDebuggerUrl) {
      throw new Error(
        `Browser Run create session missing webSocketDebuggerUrl: ${rawText.slice(0, 500)}`,
      );
    }

    const target = payload.targets?.[0];
    const rawLive =
      target?.devtoolsFrontendUrl ??
      (target?.webSocketDebuggerUrl
        ? `https://live.browser.run/ui/view?mode=tab&wss=${encodeURIComponent(target.webSocketDebuggerUrl.replace(/^wss:\/\//, ""))}`
        : undefined);

    if (!rawLive) {
      throw new Error(
        `Browser Run create session missing Live View URL (targets empty). Response: ${rawText.slice(0, 500)}`,
      );
    }

    return {
      browserSessionId: payload.sessionId ?? "unknown",
      webSocketDebuggerUrl,
      liveViewUrl: toTabLiveViewUrl(rawLive),
    };
  }

  throw new Error(lastError);
}
