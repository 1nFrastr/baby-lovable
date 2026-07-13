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
    description:
      "Read a text file from the project workspace. Cannot read .next, node_modules, or .git.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
    }),
    contextSchema: toolContextSchema,
    execute: readFileStep,
  }),
  writeFile: tool({
    description:
      "Create or overwrite a text file in the project workspace. Only src/**, public/**, and root config files are writable.",
    inputSchema: z.object({
      path: z.string().describe("Relative path inside the workspace"),
      content: z.string().describe("Full file contents to write"),
    }),
    contextSchema: toolContextSchema,
    execute: writeFileStep,
  }),
  editFile: tool({
    description:
      "Edit a text file by replacing an exact string. Prefer this for small changes to existing files instead of rewriting the whole file. Only src/**, public/**, and root config files are editable.",
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
    description:
      "List files and directories in a workspace path. Managed directories (.next, node_modules, .git) are hidden.",
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
    description:
      "Search files in the workspace using a glob pattern. Cannot search inside .next, node_modules, or .git.",
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
      "Add or remove npm packages via the platform package manager after editing package.json or when the user requests new dependencies.",
    inputSchema: z.object({
      packages: z
        .array(z.string())
        .min(1)
        .describe("Package names, e.g. [\"lucide-react\", \"date-fns\"]"),
      dev: z
        .boolean()
        .optional()
        .describe("Install as devDependencies"),
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
      "Install workspace dependencies via the platform package manager after you change package.json or the lockfile.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: installDependenciesStep,
  }),
  runCommand: tool({
    description:
      "Deprecated — prefer installPackage or installDependencies. Only package-manager install/add/remove commands are allowed; all other shell commands are rejected.",
    inputSchema: z.object({
      command: z
        .string()
        .describe("Must be a package-manager install, add, or remove command"),
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
      "Check the live dev-server preview for compile/runtime errors. Call this after editing files to verify the preview still compiles. Set restart=true to restart the managed dev server when the preview cache is corrupt (never delete .next manually). Returns { ok, status, url, httpStatus, buildError, retried, restarted }.",
    inputSchema: z.object({
      restart: z
        .boolean()
        .optional()
        .describe(
          "Restart the managed dev server before checking. Use when preview cache is corrupt — never delete .next manually.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: checkPreviewStep,
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
    execute: deleteFileStep,
  }),
};
