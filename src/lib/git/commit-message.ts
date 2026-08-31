import type { UIMessage } from "ai";

import { sanitizeJsonbText } from "@/lib/json/sanitize-jsonb";
import type { GitTurnOutcome } from "./types";

const WRITE_TOOLS = new Set([
  "tool-writeFile",
  "tool-editFile",
  "tool-deleteFile",
  "tool-installPackage",
  "tool-installDependencies",
]);

function truncate(value: string, max: number): string {
  const trimmed = sanitizeJsonbText(value).trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

export function extractChangedFiles(messages: UIMessage[]): string[] {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
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

export function buildTurnCommitMessage(input: {
  turnIndex: number;
  userPrompt: string;
  sessionId: string;
  sessionTitle?: string;
  runId: string;
  outcome: GitTurnOutcome;
  changedFiles?: string[];
}): string {
  const prompt = input.userPrompt.trim();
  const title =
    input.sessionTitle && input.sessionTitle !== "New Project"
      ? input.sessionTitle
      : null;

  const headline = title
    ? `turn-${input.turnIndex}: ${title}`
    : `turn-${input.turnIndex}: ${truncate(prompt || "turn complete", 72)}`;

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

  lines.push(
    "",
    `Session: ${input.sessionId}`,
    `Run: ${input.runId}`,
    `Outcome: ${input.outcome}`,
  );

  return sanitizeJsonbText(lines.join("\n"));
}

export function deriveTurnCommitInput(
  session: { id: string; title: string },
  messages: UIMessage[],
  runId: string,
  outcome: GitTurnOutcome,
): { turnIndex: number; userPrompt: string; commitMessage: string } {
  const userMessages = messages.filter((message) => message.role === "user");
  const turnIndex = userMessages.length;
  const lastUser = userMessages.at(-1);
  const textPart = lastUser?.parts.find((part) => part.type === "text");
  const userPrompt =
    textPart && textPart.type === "text" ? textPart.text : "turn complete";
  const changedFiles = extractChangedFiles(messages);

  return {
    turnIndex,
    userPrompt,
    commitMessage: buildTurnCommitMessage({
      turnIndex,
      userPrompt,
      sessionId: session.id,
      sessionTitle: session.title,
      runId,
      outcome,
      changedFiles,
    }),
  };
}
