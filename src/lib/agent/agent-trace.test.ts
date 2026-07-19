import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { collectIncompleteWarnings, type AgentStreamResult } from "./agent-trace";

function result(partial: Partial<AgentStreamResult>): AgentStreamResult {
  return {
    steps: [],
    finishReason: "stop",
    totalUsage: {},
    messages: [],
    ...partial,
  };
}

function toolMessage(
  toolName: string,
  output: unknown,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call_${toolName}`,
        toolName,
        output,
      },
    ],
  } as ModelMessage;
}

describe("collectIncompleteWarnings", () => {
  it("warns when files were edited without a successful checkPreview", () => {
    const warnings = collectIncompleteWarnings(
      result({
        steps: [
          {
            stepNumber: 0,
            finishReason: "tool-calls",
            toolCalls: [{ toolName: "writeFile" }],
          },
        ],
        messages: [toolMessage("writeFile", { ok: true, path: "src/app/page.tsx" })],
      }),
      null,
      30,
    );

    expect(
      warnings.some((w) => w.includes("checkPreview did not succeed")),
    ).toBe(true);
  });

  it("does not warn when edits were followed by successful checkPreview", () => {
    const warnings = collectIncompleteWarnings(
      result({
        steps: [
          {
            stepNumber: 0,
            finishReason: "stop",
            toolCalls: [{ toolName: "writeFile" }, { toolName: "checkPreview" }],
          },
        ],
        messages: [
          toolMessage("writeFile", { ok: true, path: "src/app/page.tsx" }),
          toolMessage("checkPreview", {
            ok: true,
            status: "ready",
            buildError: null,
          }),
        ],
      }),
      null,
      30,
    );

    expect(
      warnings.some((w) => w.includes("checkPreview did not succeed")),
    ).toBe(false);
  });

  it("warns when compileError was returned without a successful checkPreview", () => {
    const warnings = collectIncompleteWarnings(
      result({
        steps: [
          {
            stepNumber: 0,
            finishReason: "tool-calls",
            toolCalls: [{ toolName: "editFile" }],
          },
        ],
        messages: [
          toolMessage("editFile", {
            ok: true,
            path: "src/app/page.tsx",
            compileError: "Failed to compile",
          }),
        ],
      }),
      null,
      30,
    );

    expect(
      warnings.some((w) => w.includes("compileError was returned")),
    ).toBe(true);
  });

  it("does not warn when compileError was followed by successful checkPreview", () => {
    const warnings = collectIncompleteWarnings(
      result({
        steps: [
          {
            stepNumber: 0,
            finishReason: "tool-calls",
            toolCalls: [{ toolName: "editFile" }, { toolName: "checkPreview" }],
          },
        ],
        messages: [
          toolMessage("editFile", {
            ok: true,
            compileError: "Failed to compile",
          }),
          toolMessage("checkPreview", {
            ok: true,
            status: "ready",
            buildError: null,
          }),
        ],
      }),
      null,
      30,
    );

    expect(
      warnings.some((w) => w.includes("compileError was returned")),
    ).toBe(false);
  });
});
