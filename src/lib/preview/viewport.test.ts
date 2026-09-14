import { describe, expect, it } from "vitest";

import {
  IPHONE_VIEWPORT,
  isPreviewViewportMode,
  mobilePreviewFitScale,
  mobilePreviewFrameSize,
} from "./viewport";

describe("isPreviewViewportMode", () => {
  it("accepts desktop and mobile", () => {
    expect(isPreviewViewportMode("desktop")).toBe(true);
    expect(isPreviewViewportMode("mobile")).toBe(true);
  });

  it("rejects other values", () => {
    expect(isPreviewViewportMode("tablet")).toBe(false);
    expect(isPreviewViewportMode("")).toBe(false);
    expect(isPreviewViewportMode(null)).toBe(false);
  });
});

describe("mobilePreviewFrameSize", () => {
  it("adds bezel on each side of the iPhone viewport", () => {
    expect(mobilePreviewFrameSize()).toEqual({
      width: IPHONE_VIEWPORT.width + IPHONE_VIEWPORT.bezel * 2,
      height: IPHONE_VIEWPORT.height + IPHONE_VIEWPORT.bezel * 2,
    });
  });
});

describe("mobilePreviewFitScale", () => {
  it("stays at 1 when the pane is larger than the phone", () => {
    expect(mobilePreviewFitScale(1200, 1200)).toBe(1);
  });

  it("scales down to fit a narrower pane", () => {
    const frame = mobilePreviewFrameSize();
    const padding = IPHONE_VIEWPORT.padding;
    const containerWidth = frame.width / 2 + padding * 2;
    const containerHeight = 2000;
    expect(mobilePreviewFitScale(containerWidth, containerHeight)).toBeCloseTo(
      0.5,
    );
  });

  it("scales down to fit a shorter pane", () => {
    const frame = mobilePreviewFrameSize();
    const padding = IPHONE_VIEWPORT.padding;
    const containerWidth = 2000;
    const containerHeight = frame.height / 2 + padding * 2;
    expect(mobilePreviewFitScale(containerWidth, containerHeight)).toBeCloseTo(
      0.5,
    );
  });

  it("returns 1 when the container has not been measured", () => {
    expect(mobilePreviewFitScale(0, 0)).toBe(1);
    expect(mobilePreviewFitScale(-10, 800)).toBe(1);
  });
});
