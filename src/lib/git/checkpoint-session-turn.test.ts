import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session/store", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/git/turn-sync", () => ({
  enqueueTurnCheckpoint: vi.fn(),
}));

vi.mock("@/workflow/git-turn-checkpoint-kick", () => ({
  kickGitTurnCheckpointWorkflow: vi.fn(),
}));

import { getSession } from "@/lib/session/store";
import { enqueueTurnCheckpoint } from "@/lib/git/turn-sync";
import { kickGitTurnCheckpointWorkflow } from "@/workflow/git-turn-checkpoint-kick";
import { checkpointSessionTurn } from "./checkpoint-session-turn";

describe("checkpointSessionTurn", () => {
  afterEach(() => {
    delete process.env.DAYTONA_FREE_PLAN;
    vi.clearAllMocks();
  });

  it("no-ops when Daytona free plan is enabled", async () => {
    process.env.DAYTONA_FREE_PLAN = "1";

    const result = await checkpointSessionTurn({
      sessionId: "sess_free",
      messages: [],
      outcome: "success",
    });

    expect(result).toEqual({ ran: false });
    expect(getSession).not.toHaveBeenCalled();
    expect(enqueueTurnCheckpoint).not.toHaveBeenCalled();
    expect(kickGitTurnCheckpointWorkflow).not.toHaveBeenCalled();
  });
});
