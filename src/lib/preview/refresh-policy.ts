/**
 * After an agent turn, remount the preview iframe unless the user has been
 * interacting with it — in that case show a manual refresh prompt so we do
 * not wipe in-progress clicks, forms, or inspect-mode picking.
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

export function shouldAutoRefreshPreview(options: {
  iframeLoaded: boolean;
  userInteractedSinceLoad: boolean;
  inspectMode: boolean;
  iframeFocused: boolean;
}): boolean {
  return options.iframeLoaded && !shouldPromptPreviewRefresh(options);
}
