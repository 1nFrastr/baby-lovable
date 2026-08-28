import { describe, expect, it } from "vitest";

import {
  isActiveRunStatus,
  isTerminalRunStatus,
} from "./types";

describe("isActiveRunStatus", () => {
  it("is true only for pending/running/cancelling", () => {
    expect(isActiveRunStatus("pending")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("cancelling")).toBe(true);
    expect(isActiveRunStatus("idle")).toBe(false);
    expect(isActiveRunStatus("completed")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
    expect(isActiveRunStatus("cancelled")).toBe(false);
  });
});

describe("isTerminalRunStatus", () => {
  it("is true for completed/failed/cancelled", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("idle")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("cancelling")).toBe(false);
  });
});
