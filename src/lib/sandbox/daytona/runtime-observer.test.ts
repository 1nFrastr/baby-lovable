/**
 * observeRuntime: short HTTP timeout + soft-deadline adopt / abort.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  reconnectSandbox,
  wrapSandbox,
  getRuntimeSnapshot,
  ensureSandboxPublic,
  getDaytonaClient,
} = vi.hoisted(() => ({
  reconnectSandbox: vi.fn(),
  wrapSandbox: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
  ensureSandboxPublic: vi.fn(async () => {}),
  getDaytonaClient: vi.fn(),
}));

vi.mock("./vm", () => ({
  reconnectSandbox,
  wrapSandbox,
  ensureSandboxPublic,
  isAsleep: () => false,
}));

vi.mock("./runtime-store", () => ({
  getRuntimeSnapshot,
}));

vi.mock("./client", () => ({
  getDaytonaClient,
}));

vi.mock("./bootstrap-log", () => ({
  logDaytonaBootstrap: vi.fn(),
  logDaytonaTiming: vi.fn(),
}));

vi.mock("./config", () => ({
  getDaytonaDevPort: () => 3000,
}));

import {
  observeRuntime,
  resetObserveRuntimeForTests,
} from "./runtime-observer";
import type { DaytonaRuntimeSnapshot } from "./runtime-state";

function snap(
  partial: Partial<DaytonaRuntimeSnapshot> = {},
): DaytonaRuntimeSnapshot {
  return {
    sessionId: "sess_obs",
    desired: "preview-ready",
    observed: "starting-devserver",
    sandboxId: "sbx_1",
    devSessionName: "preview-sess_obs",
    previewUrl: "https://preview.example/app",
    previewPort: 3000,
    lastError: null,
    generation: 1,
    revision: 1,
    clearNextCache: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastObservedAt: null,
    ...partial,
  };
}

describe("observeRuntime soft deadline", () => {
  beforeEach(() => {
    resetObserveRuntimeForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
    getRuntimeSnapshot.mockResolvedValue(snap());
    getDaytonaClient.mockReturnValue({
      get: vi.fn(async () => {
        throw new Error("not found");
      }),
    });
    wrapSandbox.mockImplementation((_sid: string, sdk: unknown) => ({
      sdkSandbox: sdk,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetObserveRuntimeForTests();
  });

  it("adopts in-flight ready result during grace after soft timeout", async () => {
    reconnectSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              id: "sbx_1",
              state: "started",
              getPreviewLink: async () => ({
                url: "https://preview.example/app",
              }),
            });
          }, 9_000);
        }),
    );

    const fetchMock = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap(),
    });

    // Soft timeout at 8s — still waiting for reconnect.
    await vi.advanceTimersByTimeAsync(8_000);
    // Grace 3s: reconnect finishes at 9s, then short HTTP succeeds.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(50);

    const result = await pending;
    expect(result.phase).toBe("preview-ready");
    expect(result.httpStatus).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("stashes late ready into mailbox when grace expires", async () => {
    reconnectSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              id: "sbx_1",
              state: "started",
              getPreviewLink: async () => ({
                url: "https://preview.example/app",
              }),
            });
          }, 12_000);
        }),
    );

    const fetchMock = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap(),
    });

    // Soft (8s) + grace (3s) = 11s → hard timeout before reconnect at 12s.
    await vi.advanceTimersByTimeAsync(11_000);
    const soft = await first;
    expect(soft.phase).toBe("workspace-ready");
    expect(soft.lastError).toBe("observe timeout");
    expect(soft.sandboxId).toBe("sbx_1");

    // Late pass finishes and mails ready.
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    await Promise.resolve();

    const second = await observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap(),
    });
    expect(second.phase).toBe("preview-ready");
    expect(second.httpStatus).toBe(200);
  });

  it("treats HTTP hang/abort as not-ready without burning 5s", async () => {
    reconnectSandbox.mockResolvedValue({
      id: "sbx_1",
      state: "started",
      getPreviewLink: async () => ({ url: "https://preview.example/app" }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new DOMException("Timeout", "TimeoutError")), 1_500);
          }),
      ),
    );

    const pending = observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap(),
    });
    // Cached URL failure refreshes the Daytona link once and probes again.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(10);

    const result = await pending;
    expect(result.phase).toBe("workspace-ready");
    expect(result.sandboxId).toBe("sbx_1");
    expect(result.httpStatus).toBeNull();
    expect(result.transient).toBe(true);
  });

  it("does not coalesce passive peek with a wake observation", async () => {
    const fetchResolvers: Array<(value: { status: number }) => void> = [];
    reconnectSandbox.mockImplementation(async (_sessionId, sandboxId) => ({
      id: sandboxId,
      state: "started",
      getPreviewLink: async () => ({ url: "https://preview.example/app" }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<{ status: number }>((resolve) => {
            fetchResolvers.push(resolve);
          }),
      ),
    );

    const passive = observeRuntime("sess_obs", {
      wake: false,
      snapshot: snap(),
    });
    await Promise.resolve();
    const waking = observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(reconnectSandbox).toHaveBeenCalledTimes(2);
    expect(reconnectSandbox).toHaveBeenNthCalledWith(
      1,
      "sess_obs",
      "sbx_1",
      false,
    );
    expect(reconnectSandbox).toHaveBeenNthCalledWith(
      2,
      "sess_obs",
      "sbx_1",
      true,
    );

    for (const resolve of fetchResolvers) {
      resolve({ status: 200 });
    }
    await expect(passive).resolves.toMatchObject({ phase: "preview-ready" });
    await expect(waking).resolves.toMatchObject({ phase: "preview-ready" });
  });

  it("drops late ready from an older sandbox generation", async () => {
    reconnectSandbox.mockImplementation(
      (_sessionId: string, sandboxId: string) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                id: sandboxId,
                state: "started",
                getPreviewLink: async () => ({
                  url: `https://preview.example/${sandboxId}`,
                }),
              }),
            sandboxId === "sbx_1" ? 12_000 : 0,
          );
        }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 })));

    const first = observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap({ sandboxId: "sbx_1", generation: 1 }),
    });
    await vi.advanceTimersByTimeAsync(11_000);
    await first;
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();

    const second = observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap({
        sandboxId: "sbx_2",
        generation: 2,
        previewUrl: null,
      }),
    });
    await vi.advanceTimersByTimeAsync(10);

    await expect(second).resolves.toMatchObject({
      phase: "preview-ready",
      sandboxId: "sbx_2",
      previewUrl: "https://preview.example/sbx_2",
    });
    expect(reconnectSandbox).toHaveBeenCalledWith(
      "sess_obs",
      "sbx_2",
      true,
    );
  });

  it("refreshes a failed cached URL and only accepts 2xx or 3xx", async () => {
    const getPreviewLink = vi.fn(async () => ({
      url: "https://preview.example/refreshed",
    }));
    reconnectSandbox.mockResolvedValue({
      id: "sbx_1",
      state: "started",
      getPreviewLink,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await observeRuntime("sess_obs", {
      wake: true,
      snapshot: snap(),
    });

    expect(result).toMatchObject({
      phase: "preview-ready",
      previewUrl: "https://preview.example/refreshed",
      httpStatus: 200,
    });
    expect(ensureSandboxPublic).toHaveBeenCalledTimes(1);
    expect(getPreviewLink).toHaveBeenCalledWith(3000);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://preview.example/app",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://preview.example/refreshed",
      expect.any(Object),
    );
  });

  it("keeps workspace identity when reconnect fails but sandbox still exists", async () => {
    reconnectSandbox.mockResolvedValue(null);
    getDaytonaClient.mockReturnValue({
      get: vi.fn(async () => ({ id: "sbx_1", state: "started" })),
    });

    const result = await observeRuntime("sess_obs", {
      wake: false,
      snapshot: snap(),
    });

    expect(result).toMatchObject({
      phase: "workspace-ready",
      sandboxId: "sbx_1",
      sandboxState: "started",
      transient: true,
    });
  });
});
