/**
 * observeRuntime: short HTTP timeout + soft-deadline adopt / abort.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reconnectSandbox, wrapSandbox, getRuntimeSnapshot } = vi.hoisted(() => ({
  reconnectSandbox: vi.fn(),
  wrapSandbox: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
}));

vi.mock("./vm", () => ({
  reconnectSandbox,
  wrapSandbox,
  ensureSandboxPublic: vi.fn(async () => {}),
  isAsleep: () => false,
}));

vi.mock("./runtime-store", () => ({
  getRuntimeSnapshot,
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
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(10);

    const result = await pending;
    expect(result.phase).toBe("workspace-ready");
    expect(result.sandboxId).toBe("sbx_1");
    expect(result.httpStatus).toBeNull();
  });
});
