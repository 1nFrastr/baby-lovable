import { tool } from "ai";
import { z } from "zod";

import type { SandboxMode } from "@/lib/sandbox/types";

import {
  checkPreviewStep,
  deleteFileStep,
  editFileStep,
  installDependenciesStep,
  installPackageStep,
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
    editFile: context,
    listFiles: context,
    searchFiles: context,
    installPackage: context,
    installDependencies: context,
    runCommand: context,
    checkPreview: context,
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
  editFile: tool({
    description:
      "Edit a text file by replacing an exact string. Prefer this for small changes to existing files instead of rewriting the whole file.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
      oldString: z
        .string()
        .describe("Exact text to find. Include enough context to match only the intended location."),
      newString: z.string().describe("Replacement text"),
      replaceAll: z
        .boolean()
        .optional()
        .describe("Replace every occurrence. Defaults to false and requires a unique oldString."),
    }),
    contextSchema: toolContextSchema,
    execute: editFileStep,
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
  installPackage: tool({
    description:
      "Add or remove npm packages with pnpm after editing package.json or when the user requests new dependencies.",
    inputSchema: z.object({
      packages: z
        .array(z.string())
        .min(1)
        .describe("Package names, e.g. [\"lucide-react\", \"date-fns\"]"),
      dev: z
        .boolean()
        .optional()
        .describe("Install as devDependencies with pnpm add -D"),
      remove: z
        .boolean()
        .optional()
        .describe("Remove packages instead of adding them"),
    }),
    contextSchema: toolContextSchema,
    execute: installPackageStep,
  }),
  installDependencies: tool({
    description:
      "Run pnpm install in the workspace after you change package.json or pnpm-lock.yaml.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: installDependenciesStep,
  }),
  runCommand: tool({
    description:
      "Deprecated — prefer installPackage or installDependencies. Only pnpm install/add/remove are allowed; all other shell commands are rejected.",
    inputSchema: z.object({
      command: z
        .string()
        .describe("Must be pnpm install, pnpm add <pkg>, or pnpm remove <pkg>"),
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
  checkPreview: tool({
    description:
      "Check the live dev-server preview for compile/runtime errors. Call this after editing files to verify the preview still compiles. Returns { ok, status, url, httpStatus, buildError }.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: checkPreviewStep,
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
