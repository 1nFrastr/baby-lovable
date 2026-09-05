import {
  SummarizeContextError,
  summarizeMessages,
} from "@/lib/agent/summarize-context";
import { getSlashCommand } from "@/lib/chat/slash-commands";
import type { SessionAuthContext } from "@/lib/session/auth-context";
import { getSession, replaceMessages } from "@/lib/session/store";
import { isActiveRunStatus, type Session } from "@/lib/session/types";

export type SlashCommandSuccess = {
  ok: true;
  command: "summarize";
  session: Session;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  droppedMessageCount: number;
};

export type SlashCommandFailure = {
  ok: false;
  status: number;
  error: string;
  code:
    | "not_found"
    | "busy"
    | "conflict"
    | "unknown_command"
    | "not_enough_history"
    | "failed";
};

export type SlashCommandResult = SlashCommandSuccess | SlashCommandFailure;

export async function executeSlashCommand(input: {
  sessionId: string;
  name: string;
  args?: string;
  auth: SessionAuthContext;
}): Promise<SlashCommandResult> {
  const command = getSlashCommand(input.name);
  if (!command || command.name !== "summarize") {
    return {
      ok: false,
      status: 400,
      error: `Unknown command: /${input.name}`,
      code: "unknown_command",
    };
  }

  const auth = input.auth;
  const session = await getSession(input.sessionId, auth);
  if (!session) {
    return {
      ok: false,
      status: 404,
      error: "Session not found",
      code: "not_found",
    };
  }

  if (session.activeTurnId || isActiveRunStatus(session.runStatus)) {
    return {
      ok: false,
      status: 409,
      error: "Wait for the current turn to finish before summarizing.",
      code: "busy",
    };
  }

  const sourceMessages = session.messages;

  let summarized;
  try {
    summarized = await summarizeMessages(sourceMessages, {
      guidance: input.args,
    });
  } catch (error) {
    if (error instanceof SummarizeContextError) {
      return {
        ok: false,
        status: 400,
        error: error.message,
        code: error.code,
      };
    }
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : "Summarize failed",
      code: "failed",
    };
  }

  const latest = await getSession(input.sessionId, auth);
  if (!latest) {
    return {
      ok: false,
      status: 404,
      error: "Session not found",
      code: "not_found",
    };
  }
  if (
    latest.activeTurnId ||
    isActiveRunStatus(latest.runStatus) ||
    latest.conversationRevision !== session.conversationRevision
  ) {
    return {
      ok: false,
      status: 409,
      error: "Session changed while summarizing. Try again.",
      code: "conflict",
    };
  }

  const updated = await replaceMessages(
    input.sessionId,
    summarized.messages,
    auth,
  );

  return {
    ok: true,
    command: "summarize",
    session: updated,
    estimatedTokensBefore: summarized.estimatedTokensBefore,
    estimatedTokensAfter: summarized.estimatedTokensAfter,
    droppedMessageCount: summarized.droppedMessageCount,
  };
}
