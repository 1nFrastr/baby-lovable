import { afterEach, describe, expect, it } from "vitest";

import {
  assertSandboxMode,
  getDefaultSandboxMode,
  parseSandboxMode,
} from "./types";

describe("sandbox mode", () => {
  afterEach(() => {
    delete process.env.SANDBOX_PROVIDER;
  });

  it("selects Vercel by default", () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(getDefaultSandboxMode()).toBe("vercel");
  });

  it("honors SANDBOX_PROVIDER=daytona", () => {
    process.env.SANDBOX_PROVIDER = "daytona";
    expect(getDefaultSandboxMode()).toBe("daytona");
  });

  it("rejects the removed local mode", () => {
    expect(parseSandboxMode("local")).toBeNull();
    expect(() => assertSandboxMode("local", "sess_legacy")).toThrow(
      "Supported: daytona, vercel",
    );
  });

  it("accepts Daytona and Vercel", () => {
    expect(parseSandboxMode("daytona")).toBe("daytona");
    expect(parseSandboxMode("vercel")).toBe("vercel");
    expect(() => assertSandboxMode("daytona")).not.toThrow();
    expect(() => assertSandboxMode("vercel")).not.toThrow();
  });
});
