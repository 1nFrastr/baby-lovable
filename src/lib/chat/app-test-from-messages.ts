import { getToolName, isToolUIPart, type UIMessage } from "ai";

import type { AppTestLatestStatus } from "@/lib/browser-run/run-status";

type TestPreviewOutput = {
  liveViewUrl?: string;
  status?: "running" | "done" | "error";
  ok?: boolean;
  summary?: string;
  error?: string;
  runId?: string;
};

/**
 * Read Live View / app-test status from streamed testPreview tool outputs
 * (including preliminary yields). No disk — chat stream is the channel.
 */
export function extractAppTestStatusFromMessages(
  messages: UIMessage[],
): AppTestLatestStatus | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.parts) {
      continue;
    }

    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (!isToolUIPart(part) || getToolName(part) !== "testPreview") {
        continue;
      }

      const output =
        "output" in part && part.output && typeof part.output === "object"
          ? (part.output as TestPreviewOutput)
          : null;

      const liveViewUrl =
        typeof output?.liveViewUrl === "string" && output.liveViewUrl.length > 0
          ? output.liveViewUrl
          : undefined;

      const toolRunning =
        part.state === "input-streaming" ||
        part.state === "input-available" ||
        part.state === "approval-requested" ||
        part.state === "approval-responded" ||
        (part.state === "output-available" &&
          "preliminary" in part &&
          Boolean((part as { preliminary?: boolean }).preliminary));

      if (!liveViewUrl && !toolRunning && part.state !== "output-available") {
        continue;
      }

      if (toolRunning && liveViewUrl) {
        return {
          status: "running",
          liveViewUrl,
          summary: output?.summary,
          startedAt: new Date().toISOString(),
        };
      }

      if (part.state === "output-available" && liveViewUrl) {
        const preliminary = Boolean(
          (part as { preliminary?: boolean }).preliminary,
        );
        if (preliminary || output?.status === "running") {
          return {
            status: "running",
            liveViewUrl,
            summary: output?.summary,
          };
        }
        return {
          status: output?.ok === false || output?.status === "error"
            ? "error"
            : "done",
          liveViewUrl,
          ok: output?.ok,
          summary: output?.summary ?? output?.error,
          error: output?.error,
          finishedAt: new Date().toISOString(),
        };
      }

      if (toolRunning) {
        return {
          status: "running",
          liveViewUrl,
          summary: "Starting app test…",
        };
      }
    }
  }

  return null;
}
