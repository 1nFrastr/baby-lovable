import { describe, expect, it } from "vitest";

import { extractCompileError } from "./app-server-health";

describe("extractCompileError", () => {
  it("extracts classic compile failures", () => {
    const excerpt = extractCompileError(
      "Failed to compile\nModule not found: Can't resolve './missing'\n",
    );
    expect(excerpt).toContain("Failed to compile");
  });

  it("ignores [browser] overlay replays", () => {
    expect(
      extractCompileError("[browser] Failed to compile\nModule not found\n"),
    ).toBeNull();
  });

  it("does not treat Failed prop type as a compile marker", () => {
    expect(
      extractCompileError(
        "Error: Failed prop type: The prop 'href'\n GET / 500 in 84ms\n",
      ),
    ).toBeNull();
  });
});
