import { generateId, isToolUIPart, type UIMessage } from "ai";

import type { Session } from "@/lib/session/types";
import { isActiveRunStatus } from "@/lib/session/types";

import { logger } from "./logger";

const DEFAULT_BASE_URL =
  process.env.RESUME_TEST_BASE_URL ?? "http://localhost:3000";
const DEFAULT_PROMPT =
  "Create a minimal todo app with only a title; start with the home page";
const PARTIAL_READ_MS = 4_000;
const WORKFLOW_TIMEOUT_MS = 180_000;

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
  return ((await response.json()) as { session: Session }).session;
}

async function fetchSession(
  baseUrl: string,
  sessionId: string,
): Promise<Session> {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch session ${sessionId}: ${response.status}`);
  }
  return ((await response.json()) as { session: Session }).session;
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
    throw new Error(
      `Chat POST failed: ${response.status} ${await response.text()}`,
    );
  }

  const runId = response.headers.get("x-workflow-run-id");
  if (!runId) {
    throw new Error("Chat POST missing x-workflow-run-id header");
  }

  const reader = response.body.getReader();
  const timer = setTimeout(() => controller.abort(), readMs);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== "AbortError"
    ) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    reader.releaseLock();
  }
  return runId;
}

function activeAssistant(session: Session): UIMessage | null {
  const id = session.activeAssistantMessageId;
  if (!id) {
    return null;
  }
  return (
    session.messages.find(
      (message) => message.id === id && message.role === "assistant",
    ) ?? null
  );
}

function toolOrder(message: UIMessage): string[] {
  return message.parts
    .filter(isToolUIPart)
    .map((part) => part.toolCallId);
}

function completedTools(message: UIMessage): Set<string> {
  return new Set(
    message.parts
      .filter(
        (part) =>
          isToolUIPart(part) &&
          (part.state === "output-available" ||
            part.state === "output-error" ||
            part.state === "output-denied"),
      )
      .map((part) => part.toolCallId),
  );
}

export function validateAuthoritativeSnapshots(
  snapshots: Session[],
): string[] {
  const errors: string[] = [];
  let priorCompleted = new Set<string>();
  let priorOrder: string[] = [];
  let stableAssistantId: string | null = null;

  for (const snapshot of snapshots) {
    const ids = snapshot.messages.map((message) => message.id);
    if (new Set(ids).size !== ids.length) {
      errors.push(
        `duplicate message id at revision ${snapshot.conversationRevision}`,
      );
    }

    const assistant = activeAssistant(snapshot);
    if (!assistant) {
      continue;
    }
    stableAssistantId ??= assistant.id;
    if (assistant.id !== stableAssistantId) {
      errors.push(
        `assistant id changed ${stableAssistantId} -> ${assistant.id}`,
      );
    }

    const completed = completedTools(assistant);
    for (const toolCallId of priorCompleted) {
      if (!completed.has(toolCallId)) {
        errors.push(`completed tool regressed: ${toolCallId}`);
      }
    }

    const order = toolOrder(assistant);
    const retained = order.filter((id) => priorOrder.includes(id));
    if (retained.join("|") !== priorOrder.join("|")) {
      errors.push("tool order changed across authoritative snapshots");
    }
    priorCompleted = completed;
    priorOrder = order;
  }

  return errors;
}

async function collectUntilTerminal(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
): Promise<Session[]> {
  const deadline = Date.now() + timeoutMs;
  const snapshots: Session[] = [];
  let lastRevision = -1;

  while (Date.now() < deadline) {
    const session = await fetchSession(baseUrl, sessionId);
    if (session.conversationRevision !== lastRevision) {
      snapshots.push(session);
      lastRevision = session.conversationRevision;
    }
    if (!isActiveRunStatus(session.runStatus) && !session.activeTurnId) {
      return snapshots;
    }
    await sleep(350);
  }

  throw new Error(`Timed out waiting for ${sessionId} to finish`);
}

/**
 * Headless refresh regression: disconnect the browser stream, then repeatedly
 * reconstruct the chat from GET /session only.
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
    `started ${runId}; disconnected SSE after ${PARTIAL_READ_MS}ms`,
  );

  const snapshots = await collectUntilTerminal(
    baseUrl,
    session.id,
    WORKFLOW_TIMEOUT_MS,
  );
  const errors = validateAuthoritativeSnapshots(snapshots);
  const activeSnapshots = snapshots.filter(
    (snapshot) => activeAssistant(snapshot)?.parts.length,
  );
  const finished = snapshots.at(-1)!;
  const finalAssistant = [...finished.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const finalIds = finished.messages.map((message) => message.id);

  if (activeSnapshots.length === 0) {
    errors.push("no in-flight assistant snapshot was persisted");
  }
  if (finished.runStatus !== "completed") {
    errors.push(`terminal runStatus is ${finished.runStatus}`);
  }
  if (finished.activeTurnId || finished.activeAssistantMessageId) {
    errors.push("terminal session still owns an active turn");
  }
  if (!finalAssistant?.parts.length) {
    errors.push("final assistant content is missing");
  }
  if (new Set(finalIds).size !== finalIds.length) {
    errors.push("final conversation contains duplicate message ids");
  }

  details.push(
    `sampled ${snapshots.length} revisions; ${activeSnapshots.length} contained in-flight assistant progress`,
  );
  details.push(
    `terminal status=${finished.runStatus}, messages=${finished.messages.length}, revision=${finished.conversationRevision}`,
  );
  details.push(
    errors.length === 0
      ? "PASS: authoritative snapshots stayed stable and monotonic"
      : `FAIL: ${errors.join("; ")}`,
  );

  return {
    ok: errors.length === 0,
    sessionId: session.id,
    runId,
    details,
  };
}

export async function printResumeTestResult(
  result: ResumeTestResult,
): Promise<void> {
  for (const line of result.details) {
    logger.info(line);
  }
  if (result.ok) {
    logger.success(
      `Chat consistency test passed · session=${result.sessionId} · run=${result.runId}`,
    );
  } else {
    logger.error(
      `Chat consistency test failed · session=${result.sessionId} · run=${result.runId}`,
    );
  }
}
