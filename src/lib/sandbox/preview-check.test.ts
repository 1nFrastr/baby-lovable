import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewBackend } from "./preview-backend";
import type { AppServerCheck } from "./preview-types";

const { getPreviewBackend } = vi.hoisted(() => ({
  getPreviewBackend: vi.fn(),
}));

vi.mock("@/lib/session/store", () => ({
  getSession: vi.fn(async () => ({
    id: "sess_test",
    sandboxMode: "local",
  })),
}));

vi.mock("./preview-backend", () => ({
  getPreviewBackend,
  createPreviewBackend: vi.fn(),
}));

import {
  peekCompileErrorIfPreviewReady,
  runCheckPreviewProbe,
} from "./preview";

function mockBackend(partial: Partial<PreviewBackend>): PreviewBackend {
  return {
    getSandboxStatus: vi.fn(),
    getAppServerStatus: vi.fn(),
    checkAppServer: vi.fn(),
    getBuildError: vi.fn(),
    startPreview: vi.fn(),
    startAppServer: vi.fn(),
    restartAppServer: vi.fn(),
    stopAppServer: vi.fn(),
    deleteSandbox: vi.fn(),
    hasNodeModules: vi.fn(),
    ...partial,
  };
}

describe("peekCompileErrorIfPreviewReady", () => {
  beforeEach(() => {
    getPreviewBackend.mockReset();
  });

  it("returns compileError when preview is ready and log has an error", async () => {
    const getBuildError = vi.fn(async () => "Failed to compile\n...");
    getPreviewBackend.mockResolvedValue(
      mockBackend({
        getAppServerStatus: vi.fn(async () => ({
          status: "ready",
          url: "http://localhost:3001",
          port: 3001,
        })),
        getBuildError,
      }),
    );

    await expect(peekCompileErrorIfPreviewReady("sess_test")).resolves.toBe(
      "Failed to compile\n...",
    );
    expect(getBuildError).toHaveBeenCalledTimes(1);
  });

  it("skips getBuildError when preview is not ready", async () => {
    const getBuildError = vi.fn(async () => "should not read");
    getPreviewBackend.mockResolvedValue(
      mockBackend({
        getAppServerStatus: vi.fn(async () => ({ status: "installing" })),
        getBuildError,
      }),
    );

    await expect(peekCompileErrorIfPreviewReady("sess_test")).resolves.toBeNull();
    expect(getBuildError).not.toHaveBeenCalled();
  });
});

describe("runCheckPreviewProbe", () => {
  beforeEach(() => {
    getPreviewBackend.mockReset();
  });

  it("fast path: already ready skips settle and warm retries", async () => {
    const sleeps: number[] = [];
    const checkAppServer = vi.fn(async (): Promise<AppServerCheck> => ({
      status: "ready",
      url: "http://localhost:3001",
      httpStatus: 200,
      buildError: null,
    }));

    getPreviewBackend.mockResolvedValue(
      mockBackend({
        checkAppServer,
        restartAppServer: vi.fn(),
      }),
    );

    const result = await runCheckPreviewProbe("sess_test", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      retried: false,
      restarted: false,
    });
    expect(checkAppServer).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("warm path: polls while installing/starting", async () => {
    const sleeps: number[] = [];
    const checkAppServer = vi
      .fn()
      .mockResolvedValueOnce({
        status: "installing",
        buildError: null,
      } satisfies AppServerCheck)
      .mockResolvedValueOnce({
        status: "starting",
        buildError: null,
      } satisfies AppServerCheck)
      .mockResolvedValueOnce({
        status: "ready",
        url: "http://localhost:3001",
        httpStatus: 200,
        buildError: null,
      } satisfies AppServerCheck);

    getPreviewBackend.mockResolvedValue(
      mockBackend({
        checkAppServer,
      }),
    );

    const result = await runCheckPreviewProbe("sess_test", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.retried).toBe(true);
    expect(checkAppServer.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(sleeps[0]).toBe(1_000);
    expect(sleeps).toContain(2_000);
  });
});
