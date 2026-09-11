import { describe, expect, it } from "vitest";

import type { PreviewElementPickPayload } from "@/lib/preview/bridge-protocol";
import {
  formatPreviewPicksForPrompt,
  mergeTextWithPreviewPicks,
  previewPickChipLabel,
  truncatePickText,
} from "@/lib/preview/format-preview-pick";

const samplePick = (
  overrides: Partial<PreviewElementPickPayload> = {},
): PreviewElementPickPayload => ({
  tagName: "button",
  selector: 'button[aria-label="Add todo"]',
  path: "/todos",
  ariaLabel: "Add todo",
  textSnippet: "Add",
  ...overrides,
});

describe("formatPreviewPicksForPrompt", () => {
  it("returns empty for no picks", () => {
    expect(formatPreviewPicksForPrompt([])).toBe("");
  });

  it("formats picks with component name when present", () => {
    const text = formatPreviewPicksForPrompt([
      samplePick({ componentName: "AddTodoButton" }),
    ]);
    expect(text).toContain("Selected in preview");
    expect(text).toContain("component `AddTodoButton`");
    expect(text).toContain('`button[aria-label="Add todo"]`');
  });
});

describe("mergeTextWithPreviewPicks", () => {
  it("returns only pick block when text is empty", () => {
    const merged = mergeTextWithPreviewPicks("  ", [samplePick()]);
    expect(merged.startsWith("Selected in preview")).toBe(true);
  });

  it("prepends pick block before user text", () => {
    const merged = mergeTextWithPreviewPicks("Make it blue", [samplePick()]);
    expect(merged).toMatch(/^Selected in preview[\s\S]*\n\nMake it blue$/);
  });
});

describe("previewPickChipLabel", () => {
  it("uses component + tag, with nth when present", () => {
    expect(
      previewPickChipLabel(
        samplePick({ componentName: "AddTodoButton", testId: "add" }),
      ),
    ).toBe("AddTodoButton · button");
    expect(
      previewPickChipLabel(
        samplePick({
          componentName: "TodoList",
          tagName: "p",
          selector: "main > p:nth-of-type(1)",
        }),
      ),
    ).toBe("TodoList · p:1");
    expect(
      previewPickChipLabel(
        samplePick({
          componentName: "TodoList",
          tagName: "input",
          selector: 'form > input[aria-label="New todo"]',
        }),
      ),
    ).toBe("TodoList · input");
  });

  it("hides Next.js framework fibers like SegmentViewNode", () => {
    expect(
      previewPickChipLabel(
        samplePick({
          componentName: "SegmentViewNode",
          tagName: "main",
          selector: "main",
          ariaLabel: undefined,
          textSnippet: undefined,
        }),
      ),
    ).toBe("main");
  });

  it("falls back to tag / nth without ids", () => {
    expect(
      previewPickChipLabel(
        samplePick({ componentName: undefined, testId: undefined }),
      ),
    ).toBe("button");
    expect(
      previewPickChipLabel({
        tagName: "main",
        selector: "main",
        path: "/",
        id: "a1b2c3d4e5f6-generated",
      }),
    ).toBe("main");
    expect(
      previewPickChipLabel({
        tagName: "span",
        selector: "div > span:nth-of-type(2)",
        path: "/",
      }),
    ).toBe("span:2");
  });
});

describe("truncatePickText", () => {
  it("collapses whitespace and truncates", () => {
    expect(truncatePickText("  a   b  ")).toBe("a b");
    expect(truncatePickText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
