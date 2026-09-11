import { describe, expect, it } from "vitest";

import {
  isPreviewBridgeMessage,
  isPreviewElementPickPayload,
  PREVIEW_BRIDGE_SOURCE,
} from "@/lib/preview/bridge-protocol";

describe("bridge-protocol guards", () => {
  it("accepts baby-lovable-preview messages", () => {
    expect(
      isPreviewBridgeMessage({
        source: PREVIEW_BRIDGE_SOURCE,
        type: "element-picked",
      }),
    ).toBe(true);
    expect(isPreviewBridgeMessage({ source: "other", type: "location" })).toBe(
      false,
    );
  });

  it("validates element pick payloads", () => {
    expect(
      isPreviewElementPickPayload({
        tagName: "button",
        selector: "button.primary",
        path: "/",
        componentName: "AddButton",
      }),
    ).toBe(true);
    expect(
      isPreviewElementPickPayload({
        tagName: "button",
        selector: "button.primary",
        path: "/",
        id: 1,
      }),
    ).toBe(false);
  });
});
