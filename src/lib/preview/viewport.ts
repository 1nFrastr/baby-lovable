/** CSS viewport for a typical current iPhone (iPhone 14 / 15). */
export const IPHONE_VIEWPORT = {
  width: 390,
  height: 844,
  /** Device chrome around the iframe, in CSS pixels. */
  bezel: 10,
  /** Gap between the phone frame and the preview pane. */
  padding: 24,
} as const;

export type PreviewViewportMode = "desktop" | "mobile";

export function isPreviewViewportMode(
  value: unknown,
): value is PreviewViewportMode {
  return value === "desktop" || value === "mobile";
}

export function mobilePreviewFrameSize(
  options?: Partial<typeof IPHONE_VIEWPORT>,
): { width: number; height: number } {
  const width = options?.width ?? IPHONE_VIEWPORT.width;
  const height = options?.height ?? IPHONE_VIEWPORT.height;
  const bezel = options?.bezel ?? IPHONE_VIEWPORT.bezel;
  return {
    width: width + bezel * 2,
    height: height + bezel * 2,
  };
}

/**
 * Scale the iPhone frame down so it fits the preview pane. Never upscales.
 * Returns 1 when the container has not been measured yet.
 */
export function mobilePreviewFitScale(
  containerWidth: number,
  containerHeight: number,
  options?: Partial<typeof IPHONE_VIEWPORT>,
): number {
  const padding = options?.padding ?? IPHONE_VIEWPORT.padding;
  const frame = mobilePreviewFrameSize(options);
  const availableWidth = containerWidth - padding * 2;
  const availableHeight = containerHeight - padding * 2;

  if (frame.width <= 0 || frame.height <= 0) {
    return 1;
  }
  if (availableWidth <= 0 || availableHeight <= 0) {
    return 1;
  }

  return Math.min(1, availableWidth / frame.width, availableHeight / frame.height);
}
