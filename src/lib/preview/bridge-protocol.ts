/**
 * postMessage protocol between the host Preview panel and the generated-app
 * bridge (`templates/nextjs-starter/src/instrumentation-client.ts`).
 *
 * Keep payload shapes in sync with the template bridge.
 */

export const PREVIEW_BRIDGE_SOURCE = "baby-lovable-preview" as const;

export type PreviewNavigateAction = "back" | "forward" | "reload" | "home";

export interface PreviewBridgeLocationMessage {
  source: typeof PREVIEW_BRIDGE_SOURCE;
  type: "location";
  href: string;
  path: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface PreviewBridgeNavigateMessage {
  source: typeof PREVIEW_BRIDGE_SOURCE;
  type: "navigate";
  action: PreviewNavigateAction;
}

/** Parent → child: toggle pick-to-chat inspect mode. */
export interface PreviewBridgeInspectMessage {
  source: typeof PREVIEW_BRIDGE_SOURCE;
  type: "inspect";
  enabled: boolean;
}

/** Child → parent: inspect mode changed inside the iframe (e.g. Escape). */
export interface PreviewBridgeInspectStateMessage {
  source: typeof PREVIEW_BRIDGE_SOURCE;
  type: "inspect-state";
  enabled: boolean;
}

/** Child → parent: user clicked a DOM node while inspect is on. */
export interface PreviewElementPickPayload {
  tagName: string;
  id?: string;
  className?: string;
  textSnippet?: string;
  ariaLabel?: string;
  testId?: string;
  /** Best-effort CSS selector for searchContent / readFile targeting. */
  selector: string;
  /** Preview route path when the element was picked (e.g. `/todos`). */
  path: string;
}

export interface PreviewBridgeElementPickedMessage {
  source: typeof PREVIEW_BRIDGE_SOURCE;
  type: "element-picked";
  element: PreviewElementPickPayload;
}

export type PreviewBridgeChildMessage =
  | PreviewBridgeLocationMessage
  | PreviewBridgeInspectStateMessage
  | PreviewBridgeElementPickedMessage;

export type PreviewBridgeParentMessage =
  | PreviewBridgeNavigateMessage
  | PreviewBridgeInspectMessage;

export function isPreviewBridgeMessage(
  data: unknown,
): data is { source: typeof PREVIEW_BRIDGE_SOURCE; type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === PREVIEW_BRIDGE_SOURCE &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

export function isPreviewElementPickPayload(
  value: unknown,
): value is PreviewElementPickPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.tagName === "string" &&
    typeof v.selector === "string" &&
    typeof v.path === "string" &&
    (v.id === undefined || typeof v.id === "string") &&
    (v.className === undefined || typeof v.className === "string") &&
    (v.textSnippet === undefined || typeof v.textSnippet === "string") &&
    (v.ariaLabel === undefined || typeof v.ariaLabel === "string") &&
    (v.testId === undefined || typeof v.testId === "string")
  );
}
