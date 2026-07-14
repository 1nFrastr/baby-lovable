import { getToolName, isToolUIPart, type UIMessage } from "ai";

export type CheckPreviewOkSignal = {
  toolCallId: string;
  url?: string;
};

type CheckPreviewOutput = {
  ok?: boolean;
  status?: string;
  url?: string;
  buildError?: string | null;
};

/**
 * Latest successful checkPreview from chat tool parts (stream or history).
 * Used to remount the preview iframe when Daytona proxy blocks HMR.
 */
export function extractLatestSuccessfulCheckPreview(
  messages: UIMessage[],
): CheckPreviewOkSignal | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.parts) {
      continue;
    }

    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (!isToolUIPart(part) || getToolName(part) !== "checkPreview") {
        continue;
      }
      if (part.state !== "output-available") {
        continue;
      }
      if ("preliminary" in part && (part as { preliminary?: boolean }).preliminary) {
        continue;
      }

      const output =
        "output" in part && part.output && typeof part.output === "object"
          ? (part.output as CheckPreviewOutput)
          : null;

      if (!output || output.ok !== true) {
        continue;
      }

      return {
        toolCallId: part.toolCallId,
        url:
          typeof output.url === "string" && output.url.length > 0
            ? output.url
            : undefined,
      };
    }
  }

  return null;
}
