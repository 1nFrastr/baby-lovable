import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, getMock, getOrCreateMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getMock: vi.fn(),
  getOrCreateMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: getMock,
    create: createMock,
    getOrCreate: getOrCreateMock,
  },
}));

vi.mock("./app-server-boot", () => ({
  resumeVercelPreview: vi.fn(),
}));

vi.mock("./workspace-root", () => ({
  ensureVercelWorkspaceRoot: vi.fn(),
}));

vi.mock("./client", () => ({
  vercelAuthOptions: () => ({}),
}));

vi.mock("./config", async () => {
  const actual = await vi.importActual<typeof import("./config")>("./config");
  return {
    ...actual,
    isVercelSandboxConfigured: () => true,
  };
});

import { createVercelSandbox } from "./vm";

describe("createVercelSandbox after a stopped name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces a stopped non-persistent sandbox instead of resuming", async () => {
    const created = {
      name: "sess-abc",
      status: "running",
      delete: vi.fn(),
    };
    createMock
      .mockRejectedValueOnce(
        new Error(
          "Status code 400 is not ok: Cannot resume sandbox: no snapshot available.",
        ),
      )
      .mockResolvedValueOnce(created);
    getMock.mockResolvedValue({
      name: "sess-abc",
      status: "stopped",
      delete: vi.fn(async () => {}),
    });

    const sandbox = await createVercelSandbox("sess_abc");

    expect(sandbox).toBe(created);
    expect(getOrCreateMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a still-running sandbox when create loses the name race", async () => {
    const live = { name: "sess-abc", status: "running" };
    createMock.mockRejectedValueOnce(new Error("sandbox already exists"));
    getMock.mockResolvedValue(live);

    const sandbox = await createVercelSandbox("sess_abc");

    expect(sandbox).toBe(live);
    expect(getOrCreateMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
