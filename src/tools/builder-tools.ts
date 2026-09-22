import { tool, type ModelMessage } from "ai";
import { z } from "zod";

import { withFileMutationLock } from "@/lib/agent/file-mutation-lock";
import type { OrderedToolCall } from "@/lib/chat/turn-progress";
import {
  persistToolProgressStep,
} from "@/workflow/chat-turn-steps";

import {
  checkPreviewStep,
  deleteFileStep,
  editFileStep,
  execStep,
  readFileStep,
  testPreviewStep,
  writeFileStep,
} from "./builder-tool-steps";

export const toolContextSchema = z.object({
  sessionId: z.string(),
  turnId: z.string().optional(),
  assistantMessageId: z.string().optional(),
});

export type ToolContext = z.infer<typeof toolContextSchema>;

/** Playwright steps the Builder Agent authors from the UI it just wrote. */
export const appTestActionSchema = z.object({
  action: z
    .enum([
      "fill",
      "click",
      "press",
      "hover",
      "assertVisible",
      "assertHidden",
      "wait",
      "screenshot",
    ])
    .describe("Playwright action type"),
  selector: z
    .string()
    .optional()
    .describe(
      'Playwright locator WITHOUT backslash escapes. Good: input[placeholder="What needs to be done?"], button:has-text("Add"), input[aria-label=\'New todo\']. Bad: input[aria-label=\\"New todo\\"]. For text asserts prefer the `text` field over :has-text().',
    ),
  text: z
    .string()
    .optional()
    .describe(
      "Preferred for assertVisible/assertHidden (avoids quote escaping in selectors). Supports {{unique}}.",
    ),
  value: z
    .string()
    .optional()
    .describe('For fill. Prefer including {{unique}}, e.g. "Test item {{unique}}".'),
  key: z.string().optional().describe("For press (default Enter)."),
  ms: z.number().optional().describe("For wait, milliseconds."),
  name: z.string().optional().describe("Optional step label in the report."),
  timeoutMs: z.number().optional().describe("Per-step timeout (default 8000)."),
  continueOnError: z
    .boolean()
    .optional()
    .describe("Continue the script if this step fails."),
});

export function createToolsContext(
  sessionId: string,
  turn?: { turnId: string; assistantMessageId: string },
) {
  const context: ToolContext = { sessionId, ...turn };

  return {
    readFile: context,
    writeFile: context,
    editFile: context,
    exec: context,
    checkPreview: context,
    testPreview: context,
    deleteFile: context,
  };
}

interface ToolExecuteOptions {
  toolCallId: string;
  messages: ModelMessage[];
  context: ToolContext;
}

function orderedToolCalls(
  messages: ModelMessage[],
  current: OrderedToolCall,
): OrderedToolCall[] {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!assistant || !Array.isArray(assistant.content)) {
    return [current];
  }

  const calls = assistant.content.flatMap((part) => {
    if (
      typeof part !== "object" ||
      part === null ||
      part.type !== "tool-call"
    ) {
      return [];
    }
    return [
      {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      },
    ];
  });

  return calls.some((call) => call.toolCallId === current.toolCallId)
    ? calls
    : [...calls, current];
}

function withPathLock<TInput extends { path: string }, TOutput>(
  execute: (
    input: TInput,
    options: { context: { sessionId: string } },
  ) => Promise<TOutput>,
) {
  return (
    input: TInput,
    options: { context: { sessionId: string } },
  ): Promise<TOutput> =>
    withFileMutationLock(options.context.sessionId, input.path, () =>
      execute(input, options),
    );
}

function withTurnProgress<TInput, TOutput>(
  toolName: string,
  execute: (
    input: TInput,
    options: { context: { sessionId: string } },
  ) => Promise<TOutput>,
) {
  return async (
    input: TInput,
    options: ToolExecuteOptions,
  ): Promise<TOutput> => {
    const { turnId, assistantMessageId } = options.context;
    if (!turnId || !assistantMessageId) {
      return execute(input, options);
    }

    const current: OrderedToolCall = {
      toolCallId: options.toolCallId,
      toolName,
      input,
    };
    const calls = orderedToolCalls(options.messages, current);
    const started = await persistToolProgressStep(
      options.context.sessionId,
      turnId,
      assistantMessageId,
      { calls },
    );
    if (!started.ok) {
      throw new Error(`Turn superseded before ${toolName}`);
    }

    let output: TOutput;
    try {
      output = await execute(input, options);
    } catch (error) {
      await persistToolProgressStep(
        options.context.sessionId,
        turnId,
        assistantMessageId,
        {
          calls,
          completedCallId: options.toolCallId,
          completion: {
            success: false,
            errorText:
              error instanceof Error ? error.message : String(error),
          },
        },
      );
      throw error;
    }

    await persistToolProgressStep(
      options.context.sessionId,
      turnId,
      assistantMessageId,
      {
        calls,
        completedCallId: options.toolCallId,
        completion: { success: true, output },
      },
    );
    return output;
  };
}

export const builderTools = {
  readFile: tool({
    description:
      "Read a text file from the project workspace. Cannot read .next, node_modules, or .git.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
    }),
    contextSchema: toolContextSchema,
    execute: withTurnProgress("readFile", readFileStep),
  }),
  writeFile: tool({
    description:
      "Create or overwrite a text file in the project workspace. Only src/**, public/**, and root config files are writable. When preview is already ready, may include compileError from the live next log — fix and checkPreview if present.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
      content: z.string().describe("Full file contents to write"),
    }),
    contextSchema: toolContextSchema,
    execute: withTurnProgress("writeFile", writeFileStep),
  }),
  editFile: tool({
    description:
      "Performs exact string replacements in a workspace file. Fails if oldString is missing or not unique — add surrounding context, or set replaceAll. Only src/**, public/**, and root config files are editable. When preview is already ready, may include compileError from the live next log — fix and checkPreview if present.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
      oldString: z
        .string()
        .describe("The text to replace. Include surrounding context to make it unique unless replaceAll is true."),
      newString: z
        .string()
        .describe("The text to replace it with (must be different from oldString)"),
      replaceAll: z
        .boolean()
        .optional()
        .describe("Replace all occurrences of oldString (default false)"),
    }),
    contextSchema: toolContextSchema,
    execute: withTurnProgress("editFile", withPathLock(editFileStep)),
  }),
  exec: tool({
    description:
      "Run a sandbox bash command. Compose inspect/search/install in one pipeline (ls, find, rg, jq, pnpm add/remove/install, skill scripts, baby skills). Do not edit source with sed/redirects/rm — use editFile/writeFile/deleteFile. Do not start the dev server. Preview logs: tail .baby/logs/preview.log. Returns { ok, exitCode, stdout, stderr, truncated }.",
    inputSchema: z.object({
      command: z
        .string()
        .describe(
          "Bash command, e.g. rg -n TODO src --glob '*.tsx' | head -50",
        ),
      cwd: z
        .string()
        .optional()
        .describe("Relative working directory inside the workspace"),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in seconds (default 30 inspect / 120 pnpm; max 180)"),
    }),
    contextSchema: toolContextSchema,
    execute: withTurnProgress("exec", execStep),
  }),
  checkPreview: tool({
    description:
      "Probe preview readiness via HTTP (does not start preview; does not read logs). HTTP 500 means the app is up but broken (ok:false) — exec `tail -n 40 .baby/logs/preview.log` for the error text, fix source, then re-check. HTTP 502/503 / status installing|starting are warm-up — wait and call again. Compile hints may also arrive on writeFile/editFile as compileError. Required before finishing any turn that edited files until ok:true at least once (esp. first turn). After preview is already ready, skip for small HMR edits unless deps/config/large rewrites/compileError/httpStatus>=500/user asks. Set restart=true when the preview cache is corrupt (never delete .next manually). Returns { ok, status, url, httpStatus, buildError, retried, restarted }.",
    inputSchema: z.object({
      restart: z
        .boolean()
        .optional()
        .describe(
          "Restart the managed app server before probing. Use when preview cache is corrupt — never delete .next manually.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: withTurnProgress("checkPreview", checkPreviewStep),
  }),
  testPreview: tool({
    description:
      "Optional UI smoke test (Daytona + Browser Run). Call ONLY when the user explicitly asks to test/verify the preview in the browser — not after every checkPreview. Pass a small `actions` array (prefer 3–5 steps, max 8) for the main happy path — e.g. fill → submit → assertVisible. Do not script empty-state / delete / filter flows unless the user asked. Requires preview already ready (checkPreview ok). Does not start the preview. Returns { ok, summary, failedSteps }. On failure, fix once then stop.",
    inputSchema: z.object({
      actions: z
        .array(appTestActionSchema)
        .min(1)
        .max(8)
        .describe(
          "Short Playwright steps from your UI source. Todo example: fill input[placeholder*=\"What\"] with \"Item {{unique}}\", click button:has-text(\"Add\"), assertVisible with text \"Item {{unique}}\". Never put \\ before quotes in selectors.",
        ),
      holdMs: z
        .number()
        .optional()
        .describe(
          "Ms to wait after Live View is ready before automation (default 5000 so the UI PiP can open on Vercel). Increase if a human needs more time.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: withTurnProgress("testPreview", testPreviewStep),
  }),
  deleteFile: tool({
    description:
      "Delete a file or directory from the workspace. Only paths under src/ or public/ can be deleted.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
      recursive: z
        .boolean()
        .optional()
        .describe("Recursively delete directories"),
    }),
    contextSchema: toolContextSchema,
    execute: withTurnProgress("deleteFile", deleteFileStep),
  }),
};
