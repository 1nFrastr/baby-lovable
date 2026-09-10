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

  it("formats picks with path and selector", () => {
    const text = formatPreviewPicksForPrompt([samplePick()]);
    expect(text).toContain("Selected in preview");
    expect(text).toContain("<button> on `/todos`");
    expect(text).toContain('`button[aria-label="Add todo"]`');
    expect(text).toContain('text "Add"');
  });
});

describe("mergeTextWithPreviewPicks", () => {
  it("returns only pick block when text is empty", () => {
    const merged = mergeTextWithPreviewPicks("  ", [samplePick()]);
    expect(merged.startsWith("Selected in preview")).toBe(true);
    expect(merged).not.toMatch(/\n\n$/);
  });

  it("prepends pick block before user text", () => {
    const merged = mergeTextWithPreviewPicks("Make it blue", [samplePick()]);
    expect(merged).toMatch(/^Selected in preview[\s\S]*\n\nMake it blue$/);
  });

  it("passes through text when no picks", () => {
    expect(mergeTextWithPreviewPicks("  hello  ", [])).toBe("hello");
  });
});

describe("previewPickChipLabel", () => {
  it("prefers test id, then id, then aria-label", () => {
    expect(
      previewPickChipLabel(samplePick({ testId: "add-btn" })),
    ).toBe('[data-testid="add-btn"]');
    expect(previewPickChipLabel(samplePick({ id: "cta", testId: undefined }))).toBe(
      "#cta",
    );
    expect(
      previewPickChipLabel(
        samplePick({ id: undefined, testId: undefined, ariaLabel: "Save" }),
      ),
    ).toBe('button[aria-label="Save"]');
  });
});

describe("truncatePickText", () => {
  it("collapses whitespace and truncates", () => {
    expect(truncatePickText("  a   b  ")).toBe("a b");
    expect(truncatePickText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
