import { describe, expect, it, vi } from "vitest";

import {
  DEV_LOG_DIAGNOSE_TAIL_BYTES,
  extractCompileError,
  extractPreviewError,
  hasNextAccessLog5xx,
  isApplicationPreviewFailure,
  readDevLog,
  trimLogTail,
} from "./app-server-health";
import type { DaytonaProjectSandbox } from "./provider";

const PROP_TYPE_LOG = `
✓ Compiled in 120ms
Error: Failed prop type: The prop 'href' expects a 'string' or 'object' in '<Link>', but got 'undefined' instead.
    at ignore-listed frames { digest: '3103698990E319' }
 GET / 500 in 84ms
 GET / 500 in 84ms
`;

function mockSandbox(partial: {
  executeCommand?: ReturnType<typeof vi.fn>;
  readTextFile?: ReturnType<typeof vi.fn>;
  getFileDetails?: ReturnType<typeof vi.fn>;
}): DaytonaProjectSandbox {
  return {
    process: {
      executeCommand:
        partial.executeCommand ??
        vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "" })),
    },
    fs: {
      readTextFile: partial.readTextFile ?? vi.fn(async () => ""),
      getFileDetails:
        partial.getFileDetails ??
        vi.fn(async () => ({
          name: "next-development.log",
          path: ".next/dev/logs/next-development.log",
          isDir: false,
          size: 0,
        })),
    },
  } as unknown as DaytonaProjectSandbox;
}

describe("extractPreviewError", () => {
  it("extracts Failed prop type + digest runtime SSR errors", () => {
    const excerpt = extractPreviewError(PROP_TYPE_LOG);
    expect(excerpt).toContain("Failed prop type");
    expect(excerpt).toContain("digest:");
  });

  it("extracts GET / 5xx access lines when no other marker", () => {
    const excerpt = extractPreviewError("ready\n GET / 500 in 12ms\n");
    expect(excerpt).toMatch(/GET\s+\/\s+500/);
  });

  it("still extracts classic compile failures", () => {
    const excerpt = extractPreviewError(
      "Failed to compile\nModule not found: Can't resolve './missing'\n",
    );
    expect(excerpt).toContain("Failed to compile");
  });

  it("ignores [browser] overlay replays", () => {
    expect(
      extractPreviewError(
        "[browser] Error: Failed prop type: The prop 'href'\n",
      ),
    ).toBeNull();
  });
});

describe("extractCompileError", () => {
  it("does not treat Failed prop type as a compile marker", () => {
    expect(extractCompileError(PROP_TYPE_LOG)).toBeNull();
  });
});

describe("isApplicationPreviewFailure", () => {
  it("treats HTTP 500 as an application failure", () => {
    expect(isApplicationPreviewFailure(500, "")).toBe(true);
  });

  it("treats 502 without Next evidence as boot/proxy", () => {
    expect(isApplicationPreviewFailure(502, "Starting...")).toBe(false);
  });

  it("treats 502 with GET 5xx access log as application failure", () => {
    expect(isApplicationPreviewFailure(502, " GET / 500 in 40ms\n")).toBe(true);
  });

  it("detects Next access log 5xx", () => {
    expect(hasNextAccessLog5xx(" GET /foo 500 in 10ms")).toBe(true);
    expect(hasNextAccessLog5xx(" GET / 200 in 10ms")).toBe(false);
  });
});

describe("readDevLog", () => {
  it("prefers remote tail -c over downloading the whole file", async () => {
    const executeCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "partial-line\n GET / 500 in 10ms\n",
      stderr: "",
    }));
    const readTextFile = vi.fn(async () => "should not download");
    const log = await readDevLog(
      mockSandbox({ executeCommand, readTextFile }),
    );

    expect(executeCommand).toHaveBeenCalledWith(
      expect.stringContaining(`tail -c ${DEV_LOG_DIAGNOSE_TAIL_BYTES}`),
      ".",
      undefined,
      15,
    );
    expect(readTextFile).not.toHaveBeenCalled();
    expect(log).toBe(" GET / 500 in 10ms\n");
  });

  it("falls back to fs read only when the log is small", async () => {
    const small = "Failed to compile\n";
    const executeCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "missing",
    }));
    const readTextFile = vi.fn(async () => small);
    const getFileDetails = vi.fn(async () => ({
      name: "next-development.log",
      path: ".next/dev/logs/next-development.log",
      isDir: false,
      size: small.length,
    }));

    const log = await readDevLog(
      mockSandbox({ executeCommand, readTextFile, getFileDetails }),
    );

    expect(readTextFile).toHaveBeenCalled();
    expect(log).toBe(small);
  });

  it("does not download an oversized log when tail fails", async () => {
    const executeCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "missing",
    }));
    const readTextFile = vi.fn(async () => "should not download");
    const getFileDetails = vi.fn(async () => ({
      name: "next-development.log",
      path: ".next/dev/logs/next-development.log",
      isDir: false,
      size: DEV_LOG_DIAGNOSE_TAIL_BYTES + 1,
    }));

    const log = await readDevLog(
      mockSandbox({ executeCommand, readTextFile, getFileDetails }),
    );

    expect(readTextFile).not.toHaveBeenCalled();
    expect(log).toBe("");
  });
});

describe("trimLogTail", () => {
  it("drops a partial first line after a mid-file cut", () => {
    expect(trimLogTail("ial-line\nreal line\n")).toBe("real line\n");
  });
});
