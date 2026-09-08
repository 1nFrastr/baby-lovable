import { describe, expect, it } from "vitest";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

import {
  formatToolPartLabel,
  formatToolPartOutput,
} from "./format-tool-label";

function toolPart(
  name: string,
  input: Record<string, unknown>,
  state: ToolUIPart["state"] = "input-available",
): ToolUIPart {
  return {
    type: `tool-${name}`,
    toolCallId: "call_1",
    state,
    input,
  } as ToolUIPart;
}

describe("formatToolPartLabel", () => {
  it("labels listFiles with path or root files", () => {
    expect(formatToolPartLabel(toolPart("listFiles", { path: "src" }))).toBe(
      "Listing src",
    );
    expect(
      formatToolPartLabel(
        toolPart("listFiles", { path: "src" }, "output-available"),
      ),
    ).toBe("Listed src");
    expect(formatToolPartLabel(toolPart("listFiles", {}))).toBe(
      "Listing files",
    );
  });

  it("labels searchFiles as Searching filenames", () => {
    expect(
      formatToolPartLabel(
        toolPart("searchFiles", { pattern: "*.tsx", path: "src" }),
      ),
    ).toBe("Searching filenames *.tsx in src");
    expect(
      formatToolPartLabel(
        toolPart("searchFiles", { pattern: "*.tsx" }, "output-available"),
      ),
    ).toBe("Searched filenames *.tsx");
  });

  it("labels searchContent as Searching content", () => {
    expect(
      formatToolPartLabel(
        toolPart("searchContent", { query: "TodoItem", path: "src" }),
      ),
    ).toBe("Searching content TodoItem in src");
    expect(
      formatToolPartLabel(
        toolPart("searchContent", { query: "TodoItem" }, "output-available"),
      ),
    ).toBe("Searched content TodoItem");
  });

  it("hides inspection tool output including searchContent", () => {
    const part = {
      ...toolPart("searchContent", { query: "x" }, "output-available"),
      output: { matches: [{ path: "a.ts", line: 1, snippet: "x" }] },
    } as ToolUIPart;
    expect(formatToolPartOutput(part)).toBeNull();
  });
});

describe("formatToolPartLabel dynamic tools", () => {
  it("reads dynamic tool names", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "searchContent",
      toolCallId: "call_2",
      state: "input-available",
      input: { query: "useState" },
    } as DynamicToolUIPart;
    expect(formatToolPartLabel(part)).toBe("Searching content useState");
  });
});
