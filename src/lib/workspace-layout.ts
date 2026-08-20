/** Compact session list; chat ~38% / preview ~62% of the remaining workspace. */
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  sidebarCollapsed: false,
  sidebarWidth: 260,
  chatRatio: 0.38,
};

export const SIDEBAR_COLLAPSED_WIDTH = 52;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
/** Drag below this width snaps the session sidebar closed. */
export const SIDEBAR_COLLAPSE_SNAP = 140;
export const CHAT_RATIO_MIN = 0.24;
export const CHAT_RATIO_MAX = 0.56;

export const WORKSPACE_LAYOUT_STORAGE_KEY = "baby-lovable.workspace-layout";

export interface WorkspaceLayout {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  /** Share of the chat+preview row given to chat (preview takes the rest). */
  chatRatio: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampSidebarWidth(width: number): number {
  return clamp(Math.round(width), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
}

export function clampChatRatio(ratio: number): number {
  return clamp(ratio, CHAT_RATIO_MIN, CHAT_RATIO_MAX);
}

export function parseWorkspaceLayout(raw: string | null): WorkspaceLayout {
  if (!raw) {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_WORKSPACE_LAYOUT };
    }

    const record = parsed as Record<string, unknown>;
    return {
      sidebarCollapsed:
        typeof record.sidebarCollapsed === "boolean"
          ? record.sidebarCollapsed
          : DEFAULT_WORKSPACE_LAYOUT.sidebarCollapsed,
      sidebarWidth:
        typeof record.sidebarWidth === "number" &&
        Number.isFinite(record.sidebarWidth)
          ? clampSidebarWidth(record.sidebarWidth)
          : DEFAULT_WORKSPACE_LAYOUT.sidebarWidth,
      chatRatio:
        typeof record.chatRatio === "number" && Number.isFinite(record.chatRatio)
          ? clampChatRatio(record.chatRatio)
          : DEFAULT_WORKSPACE_LAYOUT.chatRatio,
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export function readWorkspaceLayout(): WorkspaceLayout {
  if (typeof window === "undefined") {
    return DEFAULT_WORKSPACE_LAYOUT;
  }

  try {
    return parseWorkspaceLayout(
      window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY),
    );
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export function writeWorkspaceLayout(layout: WorkspaceLayout): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        sidebarCollapsed: layout.sidebarCollapsed,
        sidebarWidth: clampSidebarWidth(layout.sidebarWidth),
        chatRatio: clampChatRatio(layout.chatRatio),
      }),
    );
  } catch {
    // Ignore quota / private-mode failures; in-memory layout still applies.
  }
}

function serializeLayout(layout: WorkspaceLayout): string {
  return `${layout.sidebarCollapsed ? 1 : 0}:${layout.sidebarWidth}:${layout.chatRatio}`;
}

const listeners = new Set<() => void>();
let clientLayout: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT;
let clientLayoutKey = serializeLayout(clientLayout);
let didHydrateClientLayout = false;

function emitLayoutChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function assignClientLayout(next: WorkspaceLayout): WorkspaceLayout {
  const key = serializeLayout(next);
  if (key === clientLayoutKey) {
    return clientLayout;
  }
  clientLayout = next;
  clientLayoutKey = key;
  emitLayoutChange();
  return clientLayout;
}

function hydrateClientLayout(): WorkspaceLayout {
  if (!didHydrateClientLayout && typeof window !== "undefined") {
    didHydrateClientLayout = true;
    const stored = readWorkspaceLayout();
    const key = serializeLayout(stored);
    if (key !== clientLayoutKey) {
      clientLayout = stored;
      clientLayoutKey = key;
    }
  }
  return clientLayout;
}

function onWindowStorage(event: StorageEvent): void {
  if (event.key !== WORKSPACE_LAYOUT_STORAGE_KEY) {
    return;
  }
  didHydrateClientLayout = true;
  assignClientLayout(parseWorkspaceLayout(event.newValue));
}

export function subscribeWorkspaceLayout(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onWindowStorage);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onWindowStorage);
    }
  };
}

export function getWorkspaceLayoutSnapshot(): WorkspaceLayout {
  return hydrateClientLayout();
}

export function getWorkspaceLayoutServerSnapshot(): WorkspaceLayout {
  return DEFAULT_WORKSPACE_LAYOUT;
}

export function patchWorkspaceLayout(
  patch: Partial<WorkspaceLayout>,
): WorkspaceLayout {
  const prev = hydrateClientLayout();
  return assignClientLayout({
    sidebarCollapsed: patch.sidebarCollapsed ?? prev.sidebarCollapsed,
    sidebarWidth: clampSidebarWidth(patch.sidebarWidth ?? prev.sidebarWidth),
    chatRatio: clampChatRatio(patch.chatRatio ?? prev.chatRatio),
  });
}

export function persistWorkspaceLayout(): void {
  writeWorkspaceLayout(hydrateClientLayout());
}
