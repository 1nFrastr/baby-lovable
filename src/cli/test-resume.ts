import {
  parseJsonEventStream,
  uiMessageChunkSchema,
  generateId,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import {
  applyResumeStreamLikeUseChat,
  claimResumeLock,
  countAssistantMessages,
  findDuplicateMessageIds,
  normalizeChatMessages,
  releaseResumeLock,
  runMultiStartResumeNormalization,
  runTextBeforeToolsMergeTest,
  simulateStrictModeResumeClaims,
} from "@/lib/chat/resume-messages";
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

async function waitForActiveRun(
  baseUrl: string,
  sessionId: string,
  expectedRunId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(baseUrl, sessionId);
    if (
      session.lastRunId === expectedRunId &&
      (session.runStatus === "running" || session.runStatus === "pending")
    ) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${sessionId} to enter running state`);
}

async function* readUiChunksFromResponse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<UIMessageChunk> {
  const chunkStream = parseJsonEventStream({
    stream: body,
    schema: uiMessageChunkSchema,
  });
  const reader = chunkStream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value.success) {
        throw value.error;
      }
      yield value.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function collectResumeStream(
  body: ReadableStream<Uint8Array>,
  baseMessages: UIMessage[],
): Promise<{ messages: UIMessage[]; chunkCount: number }> {
  let chunkCount = 0;
  const chunks: UIMessageChunk[] = [];

  for await (const chunk of readUiChunksFromResponse(body)) {
    chunkCount++;
    chunks.push(chunk);
    if (chunk.type === "finish") {
      break;
    }
  }

  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const messages = await applyResumeStreamLikeUseChat(baseMessages, stream);
  return { messages, chunkCount };
}

async function resumeWithStartIndex(
  baseUrl: string,
  sessionId: string,
  runId: string,
  startIndex: number,
  baseMessages: UIMessage[],
): Promise<{
  messages: UIMessage[];
  tailIndex: number | null;
  chunkCount: number;
}> {
  const response = await fetch(
    `${baseUrl}/api/sessions/${sessionId}/chat/${encodeURIComponent(runId)}/stream?startIndex=${startIndex}`,
  );

  if (!response.ok || !response.body) {
    throw new Error(`Resume GET failed: ${response.status}`);
  }

  const tailHeader = response.headers.get("x-workflow-stream-tail-index");
  const tailIndex =
    tailHeader != null && tailHeader !== "" ? Number(tailHeader) : null;

  const { messages, chunkCount } = await collectResumeStream(
    response.body,
    baseMessages,
  );

  return { messages, tailIndex, chunkCount };
}

async function waitForTerminalRun(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(baseUrl, sessionId);
    if (
      session.runStatus === "completed" ||
      session.runStatus === "failed" ||
      session.runStatus === "idle"
    ) {
      return;
    }
    await sleep(500);
  }
}

/**
 * Headless resume test — hits the real HTTP stream endpoints (requires
 * `npm run dev`) and asserts a single assistant message after reconnect.
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
  const thread = [userMessage];

  const runId = await startChatTurn(
    baseUrl,
    session.id,
    thread,
    PARTIAL_READ_MS,
  );
  details.push(`started chat run ${runId}, consumed ${PARTIAL_READ_MS}ms`);

  await waitForActiveRun(baseUrl, session.id, runId, 10_000);
  details.push("session persisted running state");

  const persisted = await fetchSession(baseUrl, session.id);
  const baseMessages = persisted.messages;
  details.push(`base thread has ${baseMessages.length} message(s) before resume`);

  const single = await resumeWithStartIndex(
    baseUrl,
    session.id,
    runId,
    0,
    baseMessages,
  );
  const singleNormalized = normalizeChatMessages(single.messages);
  details.push(
    `single resume: tailIndex=${single.tailIndex ?? "null"}, chunks=${single.chunkCount}, assistants=${countAssistantMessages(single.messages)} → normalized=${countAssistantMessages(singleNormalized)}`,
  );

  const strictMode = simulateStrictModeResumeClaims(session.id, runId);
  details.push(
    `strict-mode lock: first=${strictMode.first}, second=${strictMode.second}`,
  );

  const multiStart = await runMultiStartResumeNormalization();
  details.push(
    `synthetic multi-start stream: raw assistants=${multiStart.rawAssistants}, normalized=${multiStart.normalizedAssistants}, mergedText=${multiStart.mergedText ?? "null"}`,
  );

  const textBeforeTools = runTextBeforeToolsMergeTest();
  details.push(
    `text-before-tools merge: ok=${textBeforeTools.ok}, intro=${textBeforeTools.introText ?? "null"}`,
  );

  const parallel = await Promise.all([
    resumeWithStartIndex(baseUrl, session.id, runId, 0, baseMessages),
    resumeWithStartIndex(baseUrl, session.id, runId, 0, baseMessages),
  ]);
  const parallelRawAssistants = parallel.map((item) =>
    countAssistantMessages(item.messages),
  );
  const parallelNormalized = parallel.map((item) =>
    countAssistantMessages(normalizeChatMessages(item.messages)),
  );
  details.push(
    `parallel resume like Strict Mode: raw assistants=${parallelRawAssistants.join(", ")}, normalized=${parallelNormalized.join(", ")}`,
  );

  const duplicateIds = findDuplicateMessageIds(single.messages);
  const normalizedDuplicateIds = findDuplicateMessageIds(singleNormalized);
  const assistantCount = countAssistantMessages(singleNormalized);
  const userCount = singleNormalized.filter((message) => message.role === "user")
    .length;

  const ok =
    strictMode.first &&
    !strictMode.second &&
    userCount === 1 &&
    assistantCount === 1 &&
    normalizedDuplicateIds.length === 0 &&
    single.chunkCount > 0 &&
    single.tailIndex != null &&
    multiStart.rawAssistants > 1 &&
    multiStart.normalizedAssistants === 1 &&
    multiStart.mergedText === "我来帮你创建" &&
    textBeforeTools.ok;

  if (!ok) {
    details.push(
      `FAIL: user=${userCount}, assistant=${assistantCount}, rawDupes=${duplicateIds.join(",") || "none"}, normalizedDupes=${normalizedDuplicateIds.join(",") || "none"}`,
    );
  } else {
    details.push(
      "PASS: strict lock blocks double resume; multi-start stream normalizes to one assistant",
    );
  }

  await waitForTerminalRun(baseUrl, session.id, WORKFLOW_TIMEOUT_MS).catch(() => {
    details.push("workflow still running after test window (non-fatal)");
  });

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
      `Resume test passed · session=${result.sessionId} · run=${result.runId}`,
    );
    return;
  }

  logger.error(
    `Resume test failed · session=${result.sessionId} · run=${result.runId}`,
  );
}
