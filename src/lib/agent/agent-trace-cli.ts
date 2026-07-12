import { logger, truncate } from "@/cli/logger";

import { appendAgentLogLines } from "./agent-trace-file";
import {
  collectIncompleteWarnings,
  createAgentTraceCore,
  formatLine,
  type AgentStreamResult,
  type CreateAgentTraceOptions,
  type TraceSink,
} from "./agent-trace";

function createCliSink(sessionId: string): TraceSink {
  const mirror = (label: string, message: string) => {
    void appendAgentLogLines(sessionId, [formatLine(label, message)]).catch(
      () => {},
    );
  };

  return {
    info: (message) => {
      logger.info(message);
      mirror("INFO", message);
    },
    system: (message) => {
      logger.system(message);
      mirror("SYSTEM", message);
    },
    step: (message) => {
      logger.step(message);
      mirror("STEP", message);
    },
    tool: (message) => {
      logger.tool(message);
      mirror("TOOL", message);
    },
    toolOk: (message) => {
      logger.toolOk(message);
      mirror("TOOL✓", message);
    },
    toolErr: (message) => {
      logger.toolErr(message);
      mirror("TOOL✗", message);
    },
    success: (message) => {
      logger.success(message);
      mirror("DONE", message);
    },
    warn: (message) => {
      logger.warn(message);
      mirror("WARN", message);
    },
    error: (message) => {
      logger.error(message);
      mirror("ERROR", message);
    },
    assistantStart: () => {
      logger.assistantStart();
      mirror("ASSIST", "▸");
    },
    assistantDelta: (text) => {
      logger.assistantDelta(text);
      void appendAgentLogLines(sessionId, [text]).catch(() => {});
    },
    reasoningDelta: (text) => {
      logger.reasoningDelta(text);
      void appendAgentLogLines(sessionId, [text]).catch(() => {});
    },
    assistantEnd: () => {
      logger.assistantEnd();
      void appendAgentLogLines(sessionId, ["\n"]).catch(() => {});
    },
    raw: (text) => {
      logger.raw(text);
      void appendAgentLogLines(sessionId, [text]).catch(() => {});
    },
  };
}

export function createCliAgentTrace(options: CreateAgentTraceOptions) {
  return createAgentTraceCore({
    ...options,
    sink: createCliSink(options.sessionId),
    markTurnStart: () => {
      const banner = `=== turn start ${new Date().toISOString()} session=${options.sessionId} channel=cli maxSteps=${options.maxSteps} ===`;
      logger.info(banner);
      void appendAgentLogLines(options.sessionId, [formatLine("INFO", banner)]).catch(
        () => {},
      );
    },
  });
}

export { collectIncompleteWarnings, truncate, type AgentStreamResult };
