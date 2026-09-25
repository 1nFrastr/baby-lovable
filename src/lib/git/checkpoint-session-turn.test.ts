import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session/store", () => ({
  getSessionMeta: vi.fn(),
}));

vi.mock("@/lib/git/turn-sync", () => ({
  enqueueTurnCheckpoint: vi.fn(),
}));

vi.mock("@/workflow/git-turn-checkpoint-kick", () => ({
  kickGitTurnCheckpointWorkflow: vi.fn(),
}));

import { getSessionMeta } from "@/lib/session/store";
import { enqueueTurnCheckpoint } from "@/lib/git/turn-sync";
import { kickGitTurnCheckpointWorkflow } from "@/workflow/git-turn-checkpoint-kick";
import { checkpointSessionTurn } from "./checkpoint-session-turn";

describe("checkpointSessionTurn", () => {
  afterEach(() => {
    delete process.env.DAYTONA_FREE_PLAN;
    vi.clearAllMocks();
  });

  it("no-ops when Daytona free plan is enabled for a Daytona session", async () => {
    process.env.DAYTONA_FREE_PLAN = "1";
    vi.mocked(getSessionMeta).mockResolvedValue({
      id: "sess_free",
      sandboxMode: "daytona",
      title: "New Project",
      userId: "user_1",
    } as never);

    const result = await checkpointSessionTurn({
      sessionId: "sess_free",
      messages: [],
      outcome: "completed",
    });

    expect(result).toEqual({ ran: false });
    expect(enqueueTurnCheckpoint).not.toHaveBeenCalled();
    expect(kickGitTurnCheckpointWorkflow).not.toHaveBeenCalled();
  });

  it("still checkpoints Vercel sessions when Daytona free plan is on", async () => {
    process.env.DAYTONA_FREE_PLAN = "1";
    vi.mocked(getSessionMeta).mockResolvedValue({
      id: "sess_vercel",
      sandboxMode: "vercel",
      title: "Vercel Project",
      userId: "user_1",
      lastRunId: "run_1",
    } as never);
    vi.mocked(kickGitTurnCheckpointWorkflow).mockResolvedValue("wrun_1");

    const result = await checkpointSessionTurn({
      sessionId: "sess_vercel",
      messages: [],
      outcome: "completed",
    });

    expect(result.ran).toBe(true);
    expect(enqueueTurnCheckpoint).toHaveBeenCalled();
    expect(kickGitTurnCheckpointWorkflow).toHaveBeenCalled();
  });
});
