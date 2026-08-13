import { describe, expect, it, vi } from "vitest";

import { resolveDevCmdId } from "./resolve-dev-cmd-id";

describe("resolveDevCmdId", () => {
  it("returns a persisted id that still belongs to the active session", async () => {
    const getSession = vi.fn(async () => ({
      commands: [{ id: "cmd-persisted" }],
    }));
    const getSessionCommand = vi.fn(async () => ({ exitCode: null }));
    const id = await resolveDevCmdId(
      { process: { getSession, getSessionCommand } } as never,
      "preview-sess",
      "cmd-persisted",
    );
    expect(id).toBe("cmd-persisted");
    expect(getSessionCommand).toHaveBeenCalledWith(
      "preview-sess",
      "cmd-persisted",
    );
  });

  it("falls back to last session command", async () => {
    const getSession = vi.fn(async () => ({
      commands: [
        { id: "cmd-old", command: "echo a" },
        { id: "cmd-new", command: "pnpm dev" },
      ],
    }));
    const getSessionCommand = vi.fn(async () => ({ exitCode: null }));
    const id = await resolveDevCmdId(
      { process: { getSession, getSessionCommand } } as never,
      "preview-sess",
      null,
    );
    expect(id).toBe("cmd-new");
  });

  it("returns null when session has no commands", async () => {
    const getSession = vi.fn(async () => ({ commands: [] }));
    const getSessionCommand = vi.fn();
    const id = await resolveDevCmdId(
      { process: { getSession, getSessionCommand } } as never,
      "preview-sess",
      null,
    );
    expect(id).toBeNull();
  });

  it("rejects a stale persisted id and selects the newest active command", async () => {
    const getSession = vi.fn(async () => ({
      commands: [{ id: "cmd-new" }],
    }));
    const getSessionCommand = vi.fn(async () => ({ exitCode: null }));
    const id = await resolveDevCmdId(
      { process: { getSession, getSessionCommand } } as never,
      "preview-sess",
      "cmd-stale",
    );
    expect(id).toBe("cmd-new");
  });
});
