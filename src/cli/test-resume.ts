import { generateId, type UIMessage } from "ai";

import { lastAssistantMessage } from "@/lib/chat/assistant-merge";
import type { Session } from "@/lib/session/types";

import { logger } from "./logger";

const DEFAULT_BASE_URL = process.env.RESUME_TEST_BASE_URL ?? "http://localhost:3000";
const DEFAULT_PROMPT =
  "Create a minimal todo app with only a title; start with the home page";
const PARTIAL_READ_MS = 4_000;
const WORKFLOW_TIMEOUT_MS = 120_000;

export interface ResumeTestResult {
  ok: boolean;
  sessionId: string;
  runId: string;
  details: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireDevServer(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/api/sessions`);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `Dev server not reachable at ${baseUrl}. Start it with: npm run dev\n` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function createSessionViaApi(baseUrl: string): Promise<Session> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }

  const data = (await response.json()) as { session: Session };
  return data.session;
}

async function fetchSession(
  baseUrl: string,
  sessionId: string,
): Promise<Session> {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch session ${sessionId}: ${response.status}`);
  }

  const data = (await response.json()) as { session: Session };
  return data.session;
}

async function startChatTurn(
  baseUrl: string,
  sessionId: string,
  messages: UIMessage[],
  readMs: number,
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Chat POST failed: ${response.status}`);
  }

  const runId = response.headers.get("x-workflow-run-id");
  if (!runId) {
    throw new Error("Chat POST missing x-workflow-run-id header");
  }

  const reader = response.body.getReader();
  const deadline = Date.now() + readMs;

  try {
    while (Date.now() < deadline) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }

  return runId;
}

async function waitForAuthoritativeAssistantParts(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
): Promise<{ assistantId: string; partCount: number } | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(baseUrl, sessionId);
    const assistant = lastAssistantMessage(session.messages);
    if (assistant && assistant.parts.length > 0) {
      return {
        assistantId: assistant.id,
        partCount: assistant.parts.length,
      };
    }
    await sleep(250);
  }

  return null;
}

async function waitForTerminalRun(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
): Promise<Session> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(baseUrl, sessionId);
    if (
      session.runStatus === "completed" ||
      session.runStatus === "failed" ||
      session.runStatus === "idle"
    ) {
      return session;
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${sessionId} to finish`);
}

function countTextParts(message: UIMessage): number {
  return message.parts.filter((part) => part.type === "text").length;
}

/**
 * Headless refresh test — simulates refresh by reading authoritative
 * sessions.messages via API while the workflow is still running.
 */
export async function runResumeStreamTest(options?: {
  baseUrl?: string;
  prompt?: string;
}): Promise<ResumeTestResult> {
  const details: string[] = [];
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
  const prompt = options?.prompt ?? DEFAULT_PROMPT;

  await requireDevServer(baseUrl);
  details.push(`dev server ok at ${baseUrl}`);

  const session = await createSessionViaApi(baseUrl);
  details.push(`created session ${session.id}`);

  const userMessage: UIMessage = {
    id: generateId(),
    role: "user",
    parts: [{ type: "text", text: prompt }],
  };

  const runId = await startChatTurn(
    baseUrl,
    session.id,
    [userMessage],
    PARTIAL_READ_MS,
  );
  details.push(
    `started chat run ${runId}, consumed stream ${PARTIAL_READ_MS}ms then aborted (simulated refresh)`,
  );

  const midAssistant = await waitForAuthoritativeAssistantParts(
    baseUrl,
    session.id,
    15_000,
  );
  const midSession = await fetchSession(baseUrl, session.id);
  const midMessage = lastAssistantMessage(midSession.messages);
  details.push(
    midAssistant
      ? `mid-run authoritative assistant via API: id=${midAssistant.assistantId}, parts=${midAssistant.partCount}, textParts=${midMessage ? countTextParts(midMessage) : 0}`
      : "mid-run authoritative assistant via API: none",
  );

  const finished = await waitForTerminalRun(
    baseUrl,
    session.id,
    WORKFLOW_TIMEOUT_MS,
  );
  details.push(
    `workflow finished: runStatus=${finished.runStatus}, messages=${finished.messages.length}`,
  );

  const assistant = lastAssistantMessage(finished.messages);
  const userCount = finished.messages.filter((message) => message.role === "user")
    .length;

  const ok =
    Boolean(midAssistant) &&
    midAssistant!.partCount > 0 &&
    userCount === 1 &&
    Boolean(assistant) &&
    finished.runStatus === "completed";

  if (!ok) {
    details.push(
      `FAIL: midAssistant=${Boolean(midAssistant)}, user=${userCount}, assistant=${Boolean(assistant)}`,
    );
  } else {
    details.push("PASS: authoritative assistant materialized mid-run and persisted after complete");
  }

  return {
    ok,
    sessionId: session.id,
    runId,
    details,
  };
}

export async function printResumeTestResult(result: ResumeTestResult): Promise<void> {
  for (const line of result.details) {
    logger.info(line);
  }

  if (result.ok) {
    logger.info(
      `Authoritative resume test passed · session=${result.sessionId} · run=${result.runId}`,
    );
    return;
  }

  logger.error(
    `Authoritative resume test failed · session=${result.sessionId} · run=${result.runId}`,
  );
}
