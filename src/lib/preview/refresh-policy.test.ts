import { describe, expect, it } from "vitest";

import {
  shouldAutoRefreshPreview,
  shouldPromptPreviewRefresh,
} from "./refresh-policy";

describe("preview refresh after agent turn", () => {
  it("auto-refreshes when the iframe is idle", () => {
    const options = {
      iframeLoaded: true,
      userInteractedSinceLoad: false,
      inspectMode: false,
      iframeFocused: false,
    };
    expect(shouldAutoRefreshPreview(options)).toBe(true);
    expect(shouldPromptPreviewRefresh(options)).toBe(false);
  });

  it("prompts when the user has used the iframe since load", () => {
    const options = {
      iframeLoaded: true,
      userInteractedSinceLoad: true,
      inspectMode: false,
      iframeFocused: false,
    };
    expect(shouldAutoRefreshPreview(options)).toBe(false);
    expect(shouldPromptPreviewRefresh(options)).toBe(true);
  });

  it("prompts while inspect/pick mode is on", () => {
    const options = {
      iframeLoaded: true,
      userInteractedSinceLoad: false,
      inspectMode: true,
      iframeFocused: false,
    };
    expect(shouldAutoRefreshPreview(options)).toBe(false);
    expect(shouldPromptPreviewRefresh(options)).toBe(true);
  });

  it("prompts when the iframe currently has focus", () => {
    const options = {
      iframeLoaded: true,
      userInteractedSinceLoad: false,
      inspectMode: false,
      iframeFocused: true,
    };
    expect(shouldAutoRefreshPreview(options)).toBe(false);
    expect(shouldPromptPreviewRefresh(options)).toBe(true);
  });

  it("does nothing until the iframe has loaded", () => {
    const options = {
      iframeLoaded: false,
      userInteractedSinceLoad: false,
      inspectMode: false,
      iframeFocused: false,
    };
    expect(shouldAutoRefreshPreview(options)).toBe(false);
    expect(shouldPromptPreviewRefresh(options)).toBe(false);
  });
});
