import { describe, expect, it } from "vitest";

import { shouldPromptPreviewRefresh } from "./refresh-policy";

describe("preview refresh after agent turn", () => {
  it("does not prompt when the iframe is idle (HMR already applied)", () => {
    expect(
      shouldPromptPreviewRefresh({
        iframeLoaded: true,
        userInteractedSinceLoad: false,
        inspectMode: false,
        iframeFocused: false,
      }),
    ).toBe(false);
  });

  it("prompts when the user has used the iframe since load", () => {
    expect(
      shouldPromptPreviewRefresh({
        iframeLoaded: true,
        userInteractedSinceLoad: true,
        inspectMode: false,
        iframeFocused: false,
      }),
    ).toBe(true);
  });

  it("prompts while inspect/pick mode is on", () => {
    expect(
      shouldPromptPreviewRefresh({
        iframeLoaded: true,
        userInteractedSinceLoad: false,
        inspectMode: true,
        iframeFocused: false,
      }),
    ).toBe(true);
  });

  it("prompts when the iframe currently has focus", () => {
    expect(
      shouldPromptPreviewRefresh({
        iframeLoaded: true,
        userInteractedSinceLoad: false,
        inspectMode: false,
        iframeFocused: true,
      }),
    ).toBe(true);
  });

  it("does nothing until the iframe has loaded", () => {
    expect(
      shouldPromptPreviewRefresh({
        iframeLoaded: false,
        userInteractedSinceLoad: true,
        inspectMode: true,
        iframeFocused: true,
      }),
    ).toBe(false);
  });
});
