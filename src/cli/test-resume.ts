import { generateId, type UIMessage } from "ai";

import { readDraft } from "@/lib/session/draft-store";
import type { Session } from "@/lib/session/types";

import { logger } from "./logger";

const DEFAULT_BASE_URL = process.env.RESUME_TEST_BASE_URL ?? "http://localhost:3000";
const DEFAULT_PROMPT = "创建一个只有标题的极简待办应用，先写首页即可";
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

async function fetchSessionWithDraft(
  baseUrl: string,
  sessionId: string,
): Promise<{
  session: Session;
  draft: { runId: string; message: UIMessage } | null;
}> {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch session ${sessionId}: ${response.status}`);
  }

  return (await response.json()) as {
    session: Session;
    draft: { runId: string; message: UIMessage } | null;
  };
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

async function waitForDraftWithContent(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
): Promise<{ runId: string; message: UIMessage; partCount: number } | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { draft } = await fetchSessionWithDraft(baseUrl, sessionId);
    if (draft && draft.message.parts.length > 0) {
      return {
        runId: draft.runId,
        message: draft.message,
        partCount: draft.message.parts.length,
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
    const { session } = await fetchSessionWithDraft(baseUrl, sessionId);
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
 * Headless draft-resume test — simulates refresh by reading draft.json via API
 * while the workflow is still running (requires `npm run dev`).
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

  const midDraft = await waitForDraftWithContent(baseUrl, session.id, 15_000);
  details.push(
    midDraft
      ? `mid-run draft via API: runId=${midDraft.runId}, parts=${midDraft.partCount}, textParts=${countTextParts(midDraft.message)}`
      : "mid-run draft via API: none",
  );

  const onDiskDraft = await readDraft(session.id);
  details.push(
    onDiskDraft
      ? `draft.json on disk: parts=${onDiskDraft.message.parts.length}, runId=${onDiskDraft.runId}`
      : "draft.json on disk: missing",
  );

  const finished = await waitForTerminalRun(
    baseUrl,
    session.id,
    WORKFLOW_TIMEOUT_MS,
  );
  details.push(
    `workflow finished: runStatus=${finished.runStatus}, messages=${finished.messages.length}`,
  );

  const afterComplete = await readDraft(session.id);
  details.push(
    afterComplete ? "FAIL: draft.json still present after complete" : "draft.json deleted after complete",
  );

  const assistant = finished.messages.find((message) => message.role === "assistant");
  const userCount = finished.messages.filter((message) => message.role === "user")
    .length;

  const ok =
    Boolean(midDraft) &&
    midDraft!.runId === runId &&
    midDraft!.partCount > 0 &&
    Boolean(onDiskDraft) &&
    userCount === 1 &&
    Boolean(assistant) &&
    finished.runStatus === "completed" &&
    afterComplete == null;

  if (!ok) {
    details.push(
      `FAIL: midDraft=${Boolean(midDraft)}, user=${userCount}, assistant=${Boolean(assistant)}, draftCleared=${afterComplete == null}`,
    );
  } else {
    details.push("PASS: draft materialized mid-run and cleared after persist");
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
      `Draft resume test passed · session=${result.sessionId} · run=${result.runId}`,
    );
    return;
  }

  logger.error(
    `Draft resume test failed · session=${result.sessionId} · run=${result.runId}`,
  );
}
