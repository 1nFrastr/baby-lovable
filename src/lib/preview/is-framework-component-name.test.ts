import { describe, expect, it } from "vitest";

import {
  isFrameworkComponentName,
  usablePreviewComponentName,
} from "@/lib/preview/is-framework-component-name";

describe("isFrameworkComponentName", () => {
  it("filters React / Next role suffixes and known leaves", () => {
    const framework = [
      "SegmentViewNode",
      "LayoutRouterContext",
      "GlobalLayoutRouterContext",
      "TemplateContext",
      "AppRouterContext",
      "OuterLayoutRouter",
      "InnerLayoutRouter",
      "RedirectBoundary",
      "HTTPAccessFallbackBoundary",
      "LoadingBoundary",
      "LoadingBoundaryProvider",
      "NotFoundBoundary",
      "DevRootHTTPAccessFallbackBoundary",
      "ScrollAndFocusHandler",
      "ScrollAndMaybeFocusHandler",
      "ClientSegmentRoot",
      "ClientPageRoot",
      "RenderFromTemplateContext",
      "SegmentViewStateNode",
      "SegmentBoundaryTriggerNode",
      "HotReload",
      "HistoryUpdater",
      "ReactDevOverlay",
      "AppDevOverlay",
      "PathnameContext",
      "SearchParamsContext",
      "HeadManagerContext",
      "NavigationPromisesContext",
      "ThemeProvider",
      "ErrorBoundary",
      "unstable_catchError(Next.CatchError)",
    ];
    for (const name of framework) {
      expect(isFrameworkComponentName(name), name).toBe(true);
    }
  });

  it("keeps ordinary app components", () => {
    for (const name of ["TodoList", "AddTodoButton", "HomePage", "Card"]) {
      expect(isFrameworkComponentName(name), name).toBe(false);
      expect(usablePreviewComponentName(name)).toBe(name);
    }
  });

  it("unwraps Memo / ForwardRef to the inner app name", () => {
    expect(isFrameworkComponentName("ForwardRef(Button)")).toBe(false);
    expect(usablePreviewComponentName("ForwardRef(Button)")).toBe("Button");
    expect(usablePreviewComponentName("Memo(TodoList)")).toBe("TodoList");
  });
});

describe("usablePreviewComponentName", () => {
  it("returns undefined for framework fibers", () => {
    expect(usablePreviewComponentName("LayoutRouterContext")).toBeUndefined();
    expect(usablePreviewComponentName("SegmentViewNode")).toBeUndefined();
  });
});
