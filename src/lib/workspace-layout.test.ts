import { describe, expect, it } from "vitest";

import {
  CHAT_RATIO_MAX,
  CHAT_RATIO_MIN,
  DEFAULT_WORKSPACE_LAYOUT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampChatRatio,
  clampSidebarWidth,
  parseWorkspaceLayout,
} from "./workspace-layout";

describe("parseWorkspaceLayout", () => {
  it("returns defaults for missing or invalid payloads", () => {
    expect(parseWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(parseWorkspaceLayout("not json")).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(parseWorkspaceLayout("[]")).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("fills missing fields and clamps out-of-range values", () => {
    expect(parseWorkspaceLayout("{}")).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(parseWorkspaceLayout('{"sidebarWidth": 80}').sidebarWidth).toBe(
      SIDEBAR_MIN_WIDTH,
    );
    expect(parseWorkspaceLayout('{"sidebarWidth": 900}').sidebarWidth).toBe(
      SIDEBAR_MAX_WIDTH,
    );
    expect(parseWorkspaceLayout('{"chatRatio": 0.05}').chatRatio).toBe(
      CHAT_RATIO_MIN,
    );
    expect(parseWorkspaceLayout('{"chatRatio": 0.95}').chatRatio).toBe(
      CHAT_RATIO_MAX,
    );
  });

  it("keeps a valid stored layout", () => {
    expect(
      parseWorkspaceLayout(
        '{"sidebarCollapsed":true,"sidebarWidth":300,"chatRatio":0.42}',
      ),
    ).toEqual({
      sidebarCollapsed: true,
      sidebarWidth: 300,
      chatRatio: 0.42,
    });
  });
});

describe("clamp helpers", () => {
  it("rounds sidebar width to the allowed band", () => {
    expect(clampSidebarWidth(199.4)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(260.6)).toBe(261);
    expect(clampSidebarWidth(500)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("clamps chat ratio", () => {
    expect(clampChatRatio(0)).toBe(CHAT_RATIO_MIN);
    expect(clampChatRatio(0.38)).toBe(0.38);
    expect(clampChatRatio(1)).toBe(CHAT_RATIO_MAX);
  });
});
