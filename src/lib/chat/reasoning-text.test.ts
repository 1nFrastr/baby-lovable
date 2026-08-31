import { describe, expect, it } from "vitest";

import {
  REASONING_TEXT_MAX_CHARS,
  truncateReasoningText,
} from "./reasoning-text";

describe("truncateReasoningText", () => {
  it("leaves short text unchanged", () => {
    expect(truncateReasoningText("Inspect first.")).toBe("Inspect first.");
  });

  it("caps long traces with an ellipsis", () => {
    const text = "x".repeat(REASONING_TEXT_MAX_CHARS + 50);
    const truncated = truncateReasoningText(text);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.length).toBe(REASONING_TEXT_MAX_CHARS + 1);
  });
});
