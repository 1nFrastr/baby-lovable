"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import {
  SIDEBAR_COLLAPSE_SNAP,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampChatRatio,
  clampSidebarWidth,
  getWorkspaceLayoutServerSnapshot,
  getWorkspaceLayoutSnapshot,
  patchWorkspaceLayout,
  persistWorkspaceLayout,
  subscribeWorkspaceLayout,
} from "@/lib/workspace-layout";

export function useWorkspaceLayout() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const layout = useSyncExternalStore(
    subscribeWorkspaceLayout,
    getWorkspaceLayoutSnapshot,
    getWorkspaceLayoutServerSnapshot,
  );

  const beginDrag = useCallback(() => {
    setIsDragging(true);
  }, []);

  const endDrag = useCallback(() => {
    setIsDragging(false);
    persistWorkspaceLayout();
  }, []);

  const resizeSidebar = useCallback((clientX: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const raw = clientX - bounds.left;
    const prev = getWorkspaceLayoutSnapshot();

    if (prev.sidebarCollapsed) {
      if (raw >= SIDEBAR_MIN_WIDTH) {
        patchWorkspaceLayout({
          sidebarCollapsed: false,
          sidebarWidth: clampSidebarWidth(raw),
        });
      }
      return;
    }

    if (raw < SIDEBAR_COLLAPSE_SNAP) {
      patchWorkspaceLayout({ sidebarCollapsed: true });
      return;
    }

    patchWorkspaceLayout({ sidebarWidth: clampSidebarWidth(raw) });
  }, []);

  const resizeChat = useCallback((clientX: number) => {
    const bounds = mainRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) {
      return;
    }

    patchWorkspaceLayout({
      chatRatio: clampChatRatio((clientX - bounds.left) / bounds.width),
    });
  }, []);

  const toggleCollapsed = useCallback(() => {
    const prev = getWorkspaceLayoutSnapshot();
    patchWorkspaceLayout({ sidebarCollapsed: !prev.sidebarCollapsed });
    persistWorkspaceLayout();
  }, []);

  const nudgeSidebar = useCallback((deltaPx: number) => {
    const prev = getWorkspaceLayoutSnapshot();
    if (prev.sidebarCollapsed) {
      if (deltaPx > 0) {
        patchWorkspaceLayout({ sidebarCollapsed: false });
        persistWorkspaceLayout();
      }
      return;
    }

    if (prev.sidebarWidth + deltaPx < SIDEBAR_COLLAPSE_SNAP) {
      patchWorkspaceLayout({ sidebarCollapsed: true });
    } else {
      patchWorkspaceLayout({
        sidebarWidth: clampSidebarWidth(prev.sidebarWidth + deltaPx),
      });
    }
    persistWorkspaceLayout();
  }, []);

  const nudgeChat = useCallback((deltaRatio: number) => {
    const prev = getWorkspaceLayoutSnapshot();
    patchWorkspaceLayout({
      chatRatio: clampChatRatio(prev.chatRatio + deltaRatio),
    });
    persistWorkspaceLayout();
  }, []);

  return {
    containerRef,
    mainRef,
    isDragging,
    sidebarCollapsed: layout.sidebarCollapsed,
    sidebarWidth: layout.sidebarCollapsed
      ? SIDEBAR_COLLAPSED_WIDTH
      : layout.sidebarWidth,
    expandedSidebarWidth: layout.sidebarWidth,
    chatRatio: layout.chatRatio,
    beginDrag,
    endDrag,
    resizeSidebar,
    resizeChat,
    toggleCollapsed,
    nudgeSidebar,
    nudgeChat,
  };
}
