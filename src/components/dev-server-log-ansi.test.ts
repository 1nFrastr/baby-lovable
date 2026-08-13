import { describe, expect, it } from "vitest";

import { parseAnsiText } from "./dev-server-log-ansi";

describe("parseAnsiText", () => {
  it("renders common Next.js error colors without exposing escape characters", () => {
    const segments = parseAnsiText(
      '\u001b[31m\u001b[1m>\u001b[0m \u001b[90m1 |\u001b[0m import TodoApp from "@/components/TodoApp";',
    );

    expect(segments.map((segment) => segment.text).join("")).toBe(
      '> 1 | import TodoApp from "@/components/TodoApp";',
    );
    expect(segments.some((segment) => segment.style.color === "#f87171")).toBe(
      true,
    );
    expect(segments.some((segment) => segment.style.fontWeight === 700)).toBe(
      true,
    );
    expect(JSON.stringify(segments)).not.toContain("\u001b");
  });

  it("resets styles after SGR reset", () => {
    const segments = parseAnsiText("\u001b[33mwarning\u001b[0m plain");

    expect(segments[0]).toMatchObject({
      text: "warning",
      style: { color: "#facc15" },
    });
    expect(segments[1]).toEqual({ text: " plain", style: {} });
  });

  it("supports indexed and true-color sequences", () => {
    const segments = parseAnsiText(
      "\u001b[38;5;196mindexed\u001b[0m\u001b[38;2;12;34;56mrgb",
    );

    expect(segments[0]?.style.color).toBe("rgb(255, 0, 0)");
    expect(segments[1]?.style.color).toBe("rgb(12, 34, 56)");
  });

  it("drops non-text terminal control sequences", () => {
    const segments = parseAnsiText(
      "before\u001b[2K\u001b[1Gafter\u001b]0;window title\u0007",
    );

    expect(segments.map((segment) => segment.text).join("")).toBe(
      "beforeafter",
    );
  });
});
