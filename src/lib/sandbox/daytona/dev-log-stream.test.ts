import { describe, expect, it, vi } from "vitest";

import { streamDevCommandLogs } from "./dev-log-stream";

function mockSandbox(overrides: {
  snapshot?: { stdout?: string; stderr?: string };
  snapshotError?: Error;
  exitCode?: number | null;
  followChunks?: Array<{ stream: "stdout" | "stderr"; text: string }>;
}) {
  return {
    process: {
      getSessionCommandLogs: vi.fn(
        async (
          _session: string,
          _cmd: string,
          onStdout?: (chunk: string) => void,
          onStderr?: (chunk: string) => void,
        ) => {
          if (!onStdout && !onStderr) {
            if (overrides.snapshotError) {
              throw overrides.snapshotError;
            }
            return {
              stdout: overrides.snapshot?.stdout ?? "",
              stderr: overrides.snapshot?.stderr ?? "",
            };
          }
          for (const chunk of overrides.followChunks ?? []) {
            if (chunk.stream === "stdout") {
              onStdout?.(chunk.text);
            } else {
              onStderr?.(chunk.text);
            }
          }
        },
      ),
      getSessionCommand: vi.fn(async () => ({
        exitCode: overrides.exitCode ?? undefined,
      })),
    },
  };
}

describe("streamDevCommandLogs", () => {
  it("emits stale when snapshot fails", async () => {
    const sandbox = mockSandbox({
      snapshotError: new Error("not found"),
    });
    const events: unknown[] = [];
    await streamDevCommandLogs(
      sandbox as never,
      "preview-sess",
      "cmd-1",
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events).toEqual([
      {
        type: "stale",
        reason: "Failed to read command logs: not found",
      },
    ]);
  });

  it("emits snapshot then chunks while following", async () => {
    const sandbox = mockSandbox({
      snapshot: { stdout: "boot\n", stderr: "" },
      followChunks: [
        { stream: "stdout", text: "ready\n" },
        { stream: "stderr", text: "warn\n" },
      ],
    });
    const events: Array<{ type: string }> = [];
    await streamDevCommandLogs(
      sandbox as never,
      "preview-sess",
      "cmd-1",
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events).toEqual([
      { type: "snapshot", stdout: "boot\n", stderr: "" },
      { type: "chunk", stream: "stdout", text: "ready\n" },
      { type: "chunk", stream: "stderr", text: "warn\n" },
    ]);
  });

  it("emits stale when command already exited", async () => {
    const sandbox = mockSandbox({
      snapshot: { stdout: "done\n", stderr: "" },
      exitCode: 1,
    });
    const events: unknown[] = [];
    await streamDevCommandLogs(
      sandbox as never,
      "preview-sess",
      "cmd-1",
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events).toEqual([
      { type: "snapshot", stdout: "done\n", stderr: "" },
      {
        type: "stale",
        reason: "Dev command exited with code 1",
      },
    ]);
  });

  it("stops before follow when aborted after snapshot", async () => {
    const controller = new AbortController();
    const sandbox = {
      process: {
        getSessionCommandLogs: vi.fn(
          async (
            _session: string,
            _cmd: string,
            onStdout?: (chunk: string) => void,
          ) => {
            if (!onStdout) {
              controller.abort();
              return { stdout: "a", stderr: "" };
            }
            throw new Error("follow should not run");
          },
        ),
        getSessionCommand: vi.fn(async () => ({})),
      },
    };
    const events: Array<{ type: string }> = [];
    await streamDevCommandLogs(
      sandbox as never,
      "preview-sess",
      "cmd-1",
      (event) => events.push(event),
      controller.signal,
    );
    expect(events).toEqual([{ type: "snapshot", stdout: "a", stderr: "" }]);
  });
});
