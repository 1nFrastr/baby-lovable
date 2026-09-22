import { describe, expect, it } from "vitest";

import {
  describeVercelSandboxGone,
  isVercelSandboxGoneError,
  isVercelSandboxGoneHttp,
  isVercelSandboxGoneStatus,
  isVercelSandboxLiveStatus,
} from "./errors";

describe("vercel sandbox gone classification", () => {
  it("treats running/pending as live and stopped/failed as gone", () => {
    expect(isVercelSandboxLiveStatus("running")).toBe(true);
    expect(isVercelSandboxLiveStatus("pending")).toBe(true);
    expect(isVercelSandboxLiveStatus("stopped")).toBe(false);
    expect(isVercelSandboxGoneStatus("stopped")).toBe(true);
    expect(isVercelSandboxGoneStatus("stopping")).toBe(true);
    expect(isVercelSandboxGoneStatus("failed")).toBe(true);
    expect(isVercelSandboxGoneStatus("running")).toBe(false);
  });

  it("detects SANDBOX_STOPPED / 410 copy from the API and preview proxy", () => {
    expect(
      isVercelSandboxGoneError(
        new Error(
          "This sandbox was stopped and is no longer reachable.\n410 SANDBOX_STOPPED",
        ),
      ),
    ).toBe(true);
    expect(isVercelSandboxGoneError("SANDBOX_STOPPED")).toBe(true);
    expect(isVercelSandboxGoneError("sandbox not found")).toBe(true);
    expect(
      isVercelSandboxGoneError(
        "Status code 400 is not ok: Cannot resume sandbox: no snapshot available.",
      ),
    ).toBe(true);
    expect(isVercelSandboxGoneError("timeout connecting to sandbox")).toBe(
      false,
    );
    expect(isVercelSandboxGoneHttp(410)).toBe(true);
    expect(isVercelSandboxGoneHttp(502)).toBe(false);
  });

  it("formats a recreate hint", () => {
    expect(describeVercelSandboxGone("stopped")).toMatch(/stopped or deleted/i);
  });
});
