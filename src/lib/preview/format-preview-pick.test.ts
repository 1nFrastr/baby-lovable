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
  it("prefers React component name", () => {
    expect(
      previewPickChipLabel(
        samplePick({ componentName: "AddTodoButton", testId: "add" }),
      ),
    ).toBe("AddTodoButton");
  });

  it("falls back to aria / text / tag without CSS selectors", () => {
    expect(
      previewPickChipLabel(
        samplePick({ componentName: undefined, testId: undefined }),
      ),
    ).toBe('button “Add todo”');
    expect(
      previewPickChipLabel(
        samplePick({
          componentName: undefined,
          ariaLabel: undefined,
          textSnippet: "Save",
        }),
      ),
    ).toBe('button “Save”');
    expect(
      previewPickChipLabel({
        tagName: "div",
        selector: "div > span:nth-of-type(2)",
        path: "/",
      }),
    ).toBe("div");
  });
});

describe("truncatePickText", () => {
  it("collapses whitespace and truncates", () => {
    expect(truncatePickText("  a   b  ")).toBe("a b");
    expect(truncatePickText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
