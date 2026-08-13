import { afterEach, describe, expect, it } from "vitest";

import {
  assertSandboxMode,
  getDefaultSandboxMode,
  parseSandboxMode,
} from "./types";

const previousMode = process.env.BABY_LOVABLE_SANDBOX_MODE;

afterEach(() => {
  if (previousMode === undefined) {
    delete process.env.BABY_LOVABLE_SANDBOX_MODE;
  } else {
    process.env.BABY_LOVABLE_SANDBOX_MODE = previousMode;
  }
});

describe("Daytona-only sandbox mode", () => {
  it("always selects Daytona even when a legacy env flag requests local", () => {
    process.env.BABY_LOVABLE_SANDBOX_MODE = "local";
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
