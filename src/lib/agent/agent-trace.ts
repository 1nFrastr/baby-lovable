import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { LanguageModelUsage, ModelMessage, UIMessage } from "ai";

import { truncate } from "./truncate";

/** Grep-friendly prefix for host stdout (Web UI / workflow). Not a workflow step. */
export const AGENT_TRACE_TAG = "agent-trace";

export type AgentTraceChannel = "cli" | "web";

export interface AgentStreamResult {
  steps: Array<{
    stepNumber: number;
    finishReason: string;
    usage?: LanguageModelUsage;
    text?: string;
    content?: Array<{
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    }>;
    toolCalls?: Array<{
      toolName: string;
      toolCallId?: string;
      input?: unknown;
    }>;
  }>;
  finishReason: string;
  totalUsage: LanguageModelUsage;
  messages: ModelMessage[];
  /** Invisible auto-continue rounds used this turn (0 if none). */
  autoContinueCount?: number;
}

export interface CreateAgentTraceOptions {
  sessionId: string;
  maxSteps: number;
  channel: AgentTraceChannel;
}

export interface TraceSink {
  info(message: string): void;
  system(message: string): void;
  step(message: string): void;
  tool(message: string): void;
  toolOk(message: string): void;
  toolErr(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  assistantStart(): void;
  assistantDelta(text: string): void;
  reasoningDelta(text: string): void;
  assistantEnd(): void;
  raw(text: string): void;
}

interface CreateAgentTraceCoreOptions extends CreateAgentTraceOptions {
  sink: TraceSink;
  markTurnStart?: () => void;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function formatLine(label: string, message: string): string {
  return `${timestamp()} ${label.padEnd(9)} ${message}`;
}

/** Structured stdout line for log collectors: grep `[agent-trace] session=<id>`. */
export function formatTraceStdout(sessionId: string, label: string, message: string): string {
  return `[${AGENT_TRACE_TAG}] session=${sessionId} ${formatLine(label, message)}`;
}

function emitTrace(sessionId: string, label: string, message: string): void {
  console.log(formatTraceStdout(sessionId, label, message));
}

function createWebSink(sessionId: string): TraceSink {
  const write = (label: string, message: string) => {
    emitTrace(sessionId, label, message);
  };

  const render = { assistantOpen: false, reasoningOpen: false };
  let assistantChunk = "";

  const flushAssistantChunk = () => {
    if (!assistantChunk) {
      return;
    }
    console.log(
      `[${AGENT_TRACE_TAG}] session=${sessionId} ${assistantChunk}`,
    );
    assistantChunk = "";
  };

  return {
    info: (message) => write("INFO", message),
    system: (message) => write("SYSTEM", message),
    step: (message) => write("STEP", message),
    tool: (message) => write("TOOL", message),
    toolOk: (message) => write("TOOL✓", message),
    toolErr: (message) => write("TOOL✗", message),
    success: (message) => write("DONE", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
    assistantStart: () => {
      render.assistantOpen = true;
      write("ASSIST", "▸");
    },
    assistantDelta: (text) => {
      assistantChunk += text;
    },
    reasoningDelta: (text) => {
      assistantChunk += text;
    },
    assistantEnd: () => {
      flushAssistantChunk();
      render.assistantOpen = false;
      render.reasoningOpen = false;
    },
    raw: (text) => {
      console.log(`[${AGENT_TRACE_TAG}] session=${sessionId} ${text}`);
    },
  };
}

function toolResultEntries(
  messages: ModelMessage[],
): Array<{ toolName: string; output: unknown }> {
  const entries: Array<{ toolName: string; output: unknown }> = [];

  for (const message of messages) {
    const content = Array.isArray(message.content)
      ? message.content
      : [message.content];

    for (const part of content) {
      if (
        typeof part !== "object" ||
        part === null ||
        !("type" in part) ||
        part.type !== "tool-result"
      ) {
        continue;
      }

      // AI SDK uses `output`; older/persisted messages may still carry `result`.
      const fields = part as {
        toolName?: unknown;
        output?: unknown;
        result?: unknown;
      };
      const toolName =
        typeof fields.toolName === "string" ? fields.toolName : "unknown";
      const output = fields.output ?? fields.result;
      entries.push({ toolName, output });
    }
  }

  return entries;
}

function unwrapToolOutput(output: unknown): unknown {
  if (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    (output as { type: unknown }).type === "json" &&
    "value" in output
  ) {
    return (output as { value: unknown }).value;
  }
  return output;
}

function hasCompileErrorOutput(output: unknown): boolean {
  const value = unwrapToolOutput(output);
  return (
    typeof value === "object" &&
    value !== null &&
    "compileError" in value &&
    typeof (value as { compileError: unknown }).compileError === "string" &&
    (value as { compileError: string }).compileError.length > 0
  );
}

function isSuccessfulCheckPreview(output: unknown): boolean {
  const value = unwrapToolOutput(output);
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === true
  );
}

export function collectIncompleteWarnings(
  result: AgentStreamResult,
  assistantMessage: UIMessage | null,
  maxSteps: number,
): string[] {
  const warnings: string[] = [];
  const toolNames = result.steps.flatMap(
    (step) => step.toolCalls?.map((call) => call.toolName) ?? [],
  );
  const toolResults = toolResultEntries(result.messages);
  const mutated =
    toolNames.includes("writeFile") || toolNames.includes("editFile");
  const sawCompileError = toolResults.some((entry) =>
    hasCompileErrorOutput(entry.output),
  );
  const checkPreviewOk = toolResults.some(
    (entry) =>
      entry.toolName === "checkPreview" &&
      isSuccessfulCheckPreview(entry.output),
  );

  if (mutated && !checkPreviewOk) {
    warnings.push(
      sawCompileError
        ? "compileError was returned after an edit but checkPreview did not succeed afterward"
        : "edited files but checkPreview did not succeed — preview may still be warming; do not finish the first ready gate without ok:true",
    );
  }

  if (result.finishReason === "tool-calls" && result.steps.length < maxSteps) {
    warnings.push(
      `agent stopped with finishReason=tool-calls after ${result.steps.length} step(s) — turn may be incomplete`,
    );
  }

  if (result.finishReason === "tool-calls" && result.steps.length >= maxSteps) {
    warnings.push(
      (result.autoContinueCount ?? 0) > 0
        ? `agent still unfinished after ${result.autoContinueCount} auto-continue(s) at step budget — turn may be incomplete`
        : `agent hit step budget (${maxSteps}) with finishReason=tool-calls — turn may be incomplete`,
    );
  }

  if (result.finishReason === "length") {
    if ((result.autoContinueCount ?? 0) > 0) {
      warnings.push(
        `agent still hit maxOutputTokens after ${result.autoContinueCount} auto-continue(s) — turn may be incomplete`,
      );
    } else {
      warnings.push(
        "agent hit maxOutputTokens limit (finishReason=length) — tool calls may be truncated",
      );
    }
  }

  const hasAssistantText =
    assistantMessage?.parts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    ) ?? false;

  if (!hasAssistantText && toolNames.length > 0) {
    warnings.push("no assistant text in final message — only tool calls were recorded");
  }

  return warnings;
}

export function createAgentTraceCore({
  sessionId,
  maxSteps,
  channel,
  sink,
  markTurnStart: customMarkTurnStart,
}: CreateAgentTraceCoreOptions) {
  const render = { assistantOpen: false, reasoningOpen: false };

  const closeAssistantBlock = () => {
    if (render.assistantOpen || render.reasoningOpen) {
      sink.assistantEnd();
      render.assistantOpen = false;
      render.reasoningOpen = false;
    }
  };

  const markTurnStart =
    customMarkTurnStart ??
    (() => {
      const banner = `=== turn start ${new Date().toISOString()} session=${sessionId} channel=${channel} maxSteps=${maxSteps} ===`;
      sink.info(banner);
    });

  const createWritable = () =>
    new WritableStream<ModelCallStreamPart>({
      write(part) {
        switch (part.type) {
          case "text-delta": {
            if (render.reasoningOpen) {
              sink.assistantEnd();
              render.reasoningOpen = false;
            }
            if (!render.assistantOpen) {
              sink.assistantStart();
              render.assistantOpen = true;
            }
            sink.assistantDelta(part.text);
            break;
          }
          case "reasoning-delta": {
            if (!render.reasoningOpen && !render.assistantOpen) {
              sink.raw("\n");
              sink.system("reasoning ▾");
              render.reasoningOpen = true;
            }
            sink.reasoningDelta(part.text);
            break;
          }
          default:
            break;
        }
      },
    });

  const hooks = {
    experimental_onStart({
      model,
      messages: startMessages,
    }: {
      model: { modelId: string } | string;
      messages: unknown[];
    }) {
      markTurnStart();
      const modelId = typeof model === "string" ? model : model.modelId;
      sink.info(
        `agent started · model=${modelId} · contextMessages=${startMessages.length} · maxSteps=${maxSteps}`,
      );
    },

    experimental_onStepStart({ stepNumber }: { stepNumber: number }) {
      closeAssistantBlock();
      sink.step(`step #${stepNumber} → calling model…`);
    },

    onToolExecutionStart({
      toolCall,
      stepNumber,
    }: {
      toolCall: { toolName: string; input: unknown };
      stepNumber: number;
    }) {
      closeAssistantBlock();
      sink.tool(
        `[step ${stepNumber}] ${toolCall.toolName}(${truncate(toolCall.input, 400)})`,
      );
    },

    onToolExecutionEnd(event: {
      success: boolean;
      toolCall: { toolName: string };
      durationMs: number;
      output?: unknown;
      error?: unknown;
    }) {
      if (event.success) {
        sink.toolOk(
          `${event.toolCall.toolName} ✓ ${event.durationMs}ms · ${truncate(event.output)}`,
        );
        // testPreview also emits LIVE_VIEW via runAppTest console.info; reinforce for CLI.
        if (event.toolCall.toolName === "testPreview") {
          sink.info(
            "testPreview finished — if Live View was created, look for [app-test] LIVE_VIEW= in earlier logs / app-tests/*/live-view.url",
          );
        }
      } else {
        sink.toolErr(
          `${event.toolCall.toolName} ✗ ${event.durationMs}ms · ${truncate(event.error)}`,
        );
      }
    },

    onStepEnd(step: {
      stepNumber: number;
      finishReason: string;
      usage?: LanguageModelUsage;
      toolCalls?: Array<{ toolName: string }>;
    }) {
      closeAssistantBlock();
      const usage = step.usage;
      const toolCalls = step.toolCalls?.length ?? 0;
      sink.step(
        `step #${step.stepNumber} done · finish=${step.finishReason} · toolCalls=${toolCalls} · tokens(in/out)=${usage?.inputTokens ?? 0}/${usage?.outputTokens ?? 0}`,
      );
    },

    onError({ error }: { error: unknown }) {
      closeAssistantBlock();
      sink.error(
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
    },
  };

  const finalizeTurn = (
    result: AgentStreamResult,
    startedAt: number,
    assistantMessage: UIMessage | null,
  ) => {
    closeAssistantBlock();

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const usage = result.totalUsage;
    sink.success(
      `turn complete · steps=${result.steps.length} · finish=${result.finishReason}${result.autoContinueCount ? ` · autoContinues=${result.autoContinueCount}` : ""} · ${elapsed}s · tokens(in/out/total)=${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}/${usage.totalTokens ?? 0}`,
    );

    for (const warning of collectIncompleteWarnings(
      result,
      assistantMessage,
      maxSteps,
    )) {
      sink.warn(warning);
    }
  };

  return {
    hooks,
    closeAssistantBlock,
    createWritable,
    finalizeTurn,
    logInfo: (message: string) => sink.info(message),
    logWarn: (message: string) => sink.warn(message),
  };
}

/** Web/workflow trace — stdout only (`[agent-trace] session=…`), zero log workflow steps. */
export function createAgentTrace(options: CreateAgentTraceOptions) {
  return createAgentTraceCore({
    ...options,
    channel: "web",
    sink: createWebSink(options.sessionId),
    markTurnStart: () => {
      const banner = `=== turn start ${new Date().toISOString()} session=${options.sessionId} channel=web maxSteps=${options.maxSteps} ===`;
      emitTrace(options.sessionId, "INFO", banner);
    },
  });
}
