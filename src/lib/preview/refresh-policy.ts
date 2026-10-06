/**
 * After an agent turn, Next.js HMR already updates the live iframe. Do not
 * remount. Only offer a manual refresh when the user has been interacting, so
 * they can take a full reload on their own terms (forms, inspect, focus).
 */
export function shouldPromptPreviewRefresh(options: {
  iframeLoaded: boolean;
  userInteractedSinceLoad: boolean;
  inspectMode: boolean;
  iframeFocused: boolean;
}): boolean {
  if (!options.iframeLoaded) {
    return false;
  }
  return (
    options.userInteractedSinceLoad ||
    options.inspectMode ||
    options.iframeFocused
  );
}
