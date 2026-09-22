import { describe, expect, it } from "vitest";

import { clipHeadTail } from "./exec-output";

describe("clipHeadTail", () => {
  it("returns short text unchanged", () => {
    expect(clipHeadTail("hello")).toEqual({ text: "hello", truncated: false });
  });

  it("keeps head and tail when over budget", () => {
    const input = `${"A".repeat(40)}${"B".repeat(40)}${"C".repeat(40)}`;
    const clipped = clipHeadTail(input, 50);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text.startsWith("A")).toBe(true);
    expect(clipped.text.endsWith("C")).toBe(true);
    expect(clipped.text).toContain("truncated");
    expect(clipped.text.length).toBeLessThan(input.length);
  });
});
