import { describe, expect, it } from "vitest";

import {
  assertSandboxMode,
  getDefaultSandboxMode,
  parseSandboxMode,
} from "./types";

describe("Daytona-only sandbox mode", () => {
  it("selects Daytona by default", () => {
    expect(getDefaultSandboxMode()).toBe("daytona");
  });

  it("rejects the removed local mode", () => {
    expect(parseSandboxMode("local")).toBeNull();
    expect(() => assertSandboxMode("local", "sess_legacy")).toThrow(
      "Only Daytona + Freestyle sessions are supported",
    );
  });

  it("accepts Daytona", () => {
    expect(parseSandboxMode("daytona")).toBe("daytona");
    expect(() => assertSandboxMode("daytona")).not.toThrow();
  });
});
