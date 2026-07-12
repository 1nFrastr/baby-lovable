import { tool } from "ai";
import { z } from "zod";

import type { SandboxMode } from "@/lib/sandbox/types";

import {
  deleteFileStep,
  listFilesStep,
  readFileStep,
  runCommandStep,
  searchFilesStep,
  writeFileStep,
} from "./builder-tool-steps";

export const toolContextSchema = z.object({
  sessionId: z.string(),
  sandboxMode: z.enum(["local", "daytona"]),
});

export type ToolContext = z.infer<typeof toolContextSchema>;

export function createToolsContext(sessionId: string, sandboxMode: SandboxMode) {
  const context: ToolContext = { sessionId, sandboxMode };

  return {
    readFile: context,
    writeFile: context,
    listFiles: context,
    searchFiles: context,
    runCommand: context,
    deleteFile: context,
  };
}

export const builderTools = {
  readFile: tool({
    description: "Read a text file from the project workspace.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
    }),
    contextSchema: toolContextSchema,
    execute: readFileStep,
  }),
  writeFile: tool({
    description: "Create or overwrite a text file in the project workspace.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
      content: z.string().describe("Full file contents to write"),
    }),
    contextSchema: toolContextSchema,
    execute: writeFileStep,
  }),
  listFiles: tool({
    description: "List files and directories in a workspace path.",
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe("Relative directory path, defaults to workspace root"),
    }),
    contextSchema: toolContextSchema,
    execute: listFilesStep,
  }),
  searchFiles: tool({
    description: "Search files in the workspace using a glob pattern.",
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe("Relative directory path, defaults to workspace root"),
      pattern: z
        .string()
        .describe("Glob pattern such as *.tsx or src/**/*.ts"),
    }),
    contextSchema: toolContextSchema,
    execute: searchFilesStep,
  }),
  runCommand: tool({
    description:
      "Run a shell command inside the workspace, for example npm install or npm run build.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
      cwd: z
        .string()
        .optional()
        .describe("Relative working directory inside the workspace"),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in seconds, defaults to 120"),
    }),
    contextSchema: toolContextSchema,
    execute: runCommandStep,
  }),
  deleteFile: tool({
    description: "Delete a file or directory from the workspace.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
      recursive: z
        .boolean()
        .optional()
        .describe("Recursively delete directories"),
    }),
    contextSchema: toolContextSchema,
    execute: deleteFileStep,
  }),
};
