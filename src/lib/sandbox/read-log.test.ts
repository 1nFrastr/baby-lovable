import { beforeEach, describe, expect, it, vi } from "vitest";

const { getExistingDaytonaSandbox, readDevLogLines } = vi.hoisted(() => ({
  getExistingDaytonaSandbox: vi.fn(),
  readDevLogLines: vi.fn(),
}));

vi.mock("./daytona/sandbox", () => ({
  getExistingDaytonaSandbox,
}));

vi.mock("./daytona/app-server-health", () => ({
  readDevLogLines,
}));

import {
  READ_LOG_DEFAULT_LINES,
  READ_LOG_MAX_LINES,
  readSessionLog,
} from "./read-log";

describe("readSessionLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getExistingDaytonaSandbox.mockResolvedValue({ id: "sb" });
    readDevLogLines.mockResolvedValue(" GET / 500 in 12ms\n");
  });

  it("reads preview log with default line count", async () => {
    const result = await readSessionLog("sess_1", "preview");
    expect(result).toMatchObject({
      ok: true,
      source: "preview",
      lines: READ_LOG_DEFAULT_LINES,
      text: " GET / 500 in 12ms\n",
    });
    expect(readDevLogLines).toHaveBeenCalledWith(
      expect.anything(),
      READ_LOG_DEFAULT_LINES,
    );
  });

  it("caps lines at READ_LOG_MAX_LINES", async () => {
    await readSessionLog("sess_1", "preview", 999);
    expect(readDevLogLines).toHaveBeenCalledWith(
      expect.anything(),
      READ_LOG_MAX_LINES,
    );
  });

  it("rejects unknown sources", async () => {
    const result = await readSessionLog("sess_1", "supabase-fn");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported log source/);
    expect(readDevLogLines).not.toHaveBeenCalled();
  });

  it("fails when sandbox is missing", async () => {
    getExistingDaytonaSandbox.mockResolvedValue(null);
    const result = await readSessionLog("sess_1", "preview");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not available/);
  });
});
