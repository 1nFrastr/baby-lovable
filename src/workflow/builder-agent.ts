import { WorkflowAgent } from "@ai-sdk/workflow";

import { builderTools, createToolsContext } from "@/tools/builder-tools";
import type { SandboxMode } from "@/lib/sandbox/types";

export const BUILDER_SYSTEM_PROMPT = `You are baby-lovable, an expert Next.js app builder.

Your job is to help the user create and iterate on a self-contained Next.js application inside the current workspace.

Rules:
- Use the provided tools to inspect, create, edit, and delete files in the workspace.
- Prefer small, verifiable steps. After meaningful changes, run commands like \`npm install\`, \`npm run lint\`, or \`npm run build\` when appropriate.
- Generate production-quality Next.js App Router code with TypeScript and Tailwind CSS when the project needs styling.
- Keep dependencies minimal and explain major architectural choices briefly in chat.
- Never claim a file was changed unless you used writeFile.
- The workspace is pre-scaffolded with a Next.js App Router starter template (package.json, next.config, tsconfig, src/app/layout.tsx, src/app/page.tsx, Tailwind CSS). Inspect existing files with listFiles/readFile before changing them.
- Make incremental edits to the starter project instead of recreating the scaffold from scratch. Only add new files or dependencies when the user's request requires them.
- Run \`npm install\` before the first build/dev command if node_modules is missing.
- Paths passed to tools are relative to the workspace root.
- If a command fails, inspect the output, fix the issue, and retry.`;

export interface BuilderAgentContext {
  sessionId: string;
  sandboxMode: SandboxMode;
}

export interface BuilderAgentBundle {
  agent: WorkflowAgent<typeof builderTools, BuilderAgentContext>;
  toolsContext: ReturnType<typeof createToolsContext>;
  runtimeContext: BuilderAgentContext;
}

/**
 * Build a WorkflowAgent configured for the app builder. Shared by the web
 * workflow (`builderChat`) and the CLI runner so both exercise the exact
 * same model, instructions, and tools.
 */
export function createBuilderAgent(
  sessionId: string,
  sandboxMode: SandboxMode,
): BuilderAgentBundle {
  const toolsContext = createToolsContext(sessionId, sandboxMode);
  const runtimeContext: BuilderAgentContext = { sessionId, sandboxMode };

  const agent = new WorkflowAgent({
    model: process.env.AI_MODEL ?? "minimax/minimax-m3",
    instructions: BUILDER_SYSTEM_PROMPT,
    tools: builderTools,
    toolsContext,
    runtimeContext,
  });

  return { agent, toolsContext, runtimeContext };
}
