/**
 * Trim a document Selection so it cannot cross `container`'s boundary.
 * Chromium lets a range that starts in adjacent text end inside a nearby
 * textarea, which paints a caret on the empty composer.
 */
export function clipSelectionToContainer(container: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  const startIn = container.contains(startNode) || startNode === container;
  const endIn = container.contains(endNode) || endNode === container;

  if (startIn === endIn) {
    return false;
  }

  const next = range.cloneRange();
  if (startIn) {
    next.setEnd(container, container.childNodes.length);
  } else {
    next.setStart(container, 0);
  }

  selection.removeAllRanges();
  selection.addRange(next);
  return true;
}

export function blurFocusOutside(container: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !container.contains(active)) {
    active.blur();
  }
}
