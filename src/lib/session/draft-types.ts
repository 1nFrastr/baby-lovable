import { generateId, type UIMessage } from "ai";

export interface SessionDraft {
  runId: string;
  message: UIMessage;
  updatedAt: string;
}

export function createEmptyDraft(runId: string): SessionDraft {
  return {
    runId,
    message: {
      id: generateId(),
      role: "assistant",
      parts: [],
    },
    updatedAt: new Date().toISOString(),
  };
}
