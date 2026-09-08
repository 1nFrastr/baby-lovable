import { describe, expect, it, vi } from "vitest";

import { installWorkspaceFromLockfile } from "./workspace-restore";

describe("installWorkspaceFromLockfile", () => {
  it("runs pnpm install --frozen-lockfile and throws on non-zero exit", async () => {
    const executeCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    await installWorkspaceFromLockfile(
      { process: { executeCommand } } as never,
      "sess_1",
    );
    expect(executeCommand).toHaveBeenCalledWith(
      "pnpm install --frozen-lockfile",
      ".",
      undefined,
      180,
    );

    executeCommand.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "ERR_PNPM_OUTDATED_LOCKFILE",
      stderr: "",
    });
    await expect(
      installWorkspaceFromLockfile(
        { process: { executeCommand } } as never,
        "sess_1",
      ),
    ).rejects.toThrow(/frozen-lockfile failed \(exit 1\)/);
  });
});
