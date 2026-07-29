import { describe, expect, it, vi } from "vitest";

import { resolveDevCmdId } from "./resolve-dev-cmd-id";

describe("resolveDevCmdId", () => {
  it("returns persisted id without listing", async () => {
    const getSession = vi.fn();
    const id = await resolveDevCmdId(
      { process: { getSession } } as never,
      "preview-sess",
      "cmd-persisted",
    );
    expect(id).toBe("cmd-persisted");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("falls back to last session command", async () => {
    const getSession = vi.fn(async () => ({
      commands: [
        { id: "cmd-old", command: "echo a" },
        { id: "cmd-new", command: "pnpm dev" },
      ],
    }));
    const id = await resolveDevCmdId(
      { process: { getSession } } as never,
      "preview-sess",
      null,
    );
    expect(id).toBe("cmd-new");
  });

  it("returns null when session has no commands", async () => {
    const getSession = vi.fn(async () => ({ commands: [] }));
    const id = await resolveDevCmdId(
      { process: { getSession } } as never,
      "preview-sess",
      null,
    );
    expect(id).toBeNull();
  });
});
