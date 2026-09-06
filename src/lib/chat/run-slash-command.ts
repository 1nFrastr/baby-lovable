import { generateId } from "ai";

import { compactSessionMessages } from "@/lib/chat/run-compaction";
import { getSlashCommand } from "@/lib/chat/slash-commands";
import type { SessionAuthContext } from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";
import { isActiveRunStatus, type Session } from "@/lib/session/types";

export type SlashCommandSuccess = {
  ok: true;
  command: "summarize";
  session: Session;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
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

  const session = await getSession(input.sessionId, input.auth);
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

  const turnId = `sum_${generateId()}`;
  const compacted = await compactSessionMessages({
    sessionId: input.sessionId,
    turnId,
    messages: session.messages,
    persistMode: "replace",
    force: true,
    append: true,
    guidance: input.args,
    auth: input.auth,
  });

  if (!compacted.ok) {
    return {
      ok: false,
      status: compacted.code === "failed" ? 500 : 400,
      error: compacted.error,
      code:
        compacted.code === "not_enough_history"
          ? "not_enough_history"
          : "failed",
    };
  }

  const latest = await getSession(input.sessionId, input.auth);
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
    isActiveRunStatus(latest.runStatus)
  ) {
    return {
      ok: false,
      status: 409,
      error: "Session changed while summarizing. Try again.",
      code: "conflict",
    };
  }

  return {
    ok: true,
    command: "summarize",
    session: latest,
    estimatedTokensBefore: compacted.estimatedTokensBefore,
    estimatedTokensAfter: compacted.estimatedTokensAfter,
  };
}
