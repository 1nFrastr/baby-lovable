import type { UIMessage } from "ai";

import type { CommitTurnResult } from "./git-runner";
import type { ProjectSandbox } from "./types";

export type { CommitTurnResult };

export interface CommitTurnInput {
  turnIndex: number;
  userPrompt: string;
  sessionId?: string;
  sessionTitle?: string;
  changedFiles?: string[];
  messageOverride?: string;
}

const WRITE_TOOLS = new Set(["tool-writeFile", "tool-editFile", "tool-deleteFile"]);

function extractChangedFiles(messages: UIMessage[]): string[] {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) {
    return [];
  }

  const files: string[] = [];
  for (const part of lastAssistant.parts) {
    if (!part.type.startsWith("tool-") || !WRITE_TOOLS.has(part.type)) {
      continue;
    }

    if (!("input" in part) || !part.input || typeof part.input !== "object") {
      continue;
    }

    const filePath = (part.input as { path?: string }).path;
    if (filePath) {
      files.push(filePath);
    }
  }

  return [...new Set(files)];
}

export function buildTurnCommitInput(
  session: { id: string; title: string },
  messages: UIMessage[],
): CommitTurnInput {
  const userMessages = messages.filter((message) => message.role === "user");
  const turnIndex = userMessages.length;
  const lastUser = userMessages.at(-1);
  const textPart = lastUser?.parts.find((part) => part.type === "text");
  const userPrompt =
    textPart && textPart.type === "text" ? textPart.text : "turn complete";

  return {
    turnIndex,
    userPrompt,
    sessionId: session.id,
    sessionTitle: session.title,
    changedFiles: extractChangedFiles(messages),
  };
}

function formatCommitMessage(input: CommitTurnInput): string {
  if (input.messageOverride) {
    return input.messageOverride;
  }

  const prompt = input.userPrompt.trim();
  const title =
    input.sessionTitle && input.sessionTitle !== "New Project"
      ? input.sessionTitle
      : null;

  const headline = title
    ? `turn-${input.turnIndex}: ${title}`
    : `turn-${input.turnIndex}: ${truncate(prompt, 72)}`;

  const lines = [headline];

  if (title && prompt) {
    lines.push("", `User: ${truncate(prompt, 240)}`);
  }

  if (input.changedFiles && input.changedFiles.length > 0) {
    const listed = input.changedFiles.slice(0, 12).join(", ");
    const overflow =
      input.changedFiles.length > 12
        ? ` (+${input.changedFiles.length - 12} more)`
        : "";
    lines.push("", `Files: ${listed}${overflow}`);
  }

  if (input.sessionId) {
    lines.push("", `Session: ${input.sessionId}`);
  }

  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

export async function commitWorkspaceTurn(
  sandbox: ProjectSandbox,
  input: CommitTurnInput,
): Promise<CommitTurnResult> {
  const repo = await sandbox.git.ensureRepo();
  if (!repo.ok) {
    return {
      sha: null,
      committed: false,
      skippedReason: repo.reason,
    };
  }

  if (!(await sandbox.git.hasChanges())) {
    return { sha: null, committed: false, skippedReason: "no workspace changes" };
  }

  return sandbox.git.commitAll(formatCommitMessage(input));
}

export async function initWorkspaceGit(
  sandbox: ProjectSandbox,
  initialMessage = "init: nextjs starter",
): Promise<CommitTurnResult> {
  const repo = await sandbox.git.ensureRepo();
  if (!repo.ok) {
    return {
      sha: null,
      committed: false,
      skippedReason: repo.reason,
    };
  }

  return commitWorkspaceTurn(sandbox, {
    turnIndex: 0,
    userPrompt: "",
    messageOverride: initialMessage,
  });
}
