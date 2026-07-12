---
name: ai-sdk-v7-workflow-agent
description: >-
  Build durable AI agents with Vercel AI SDK v7 WorkflowAgent and Workflow DevKit.
  Use when working with WorkflowAgent, @ai-sdk/workflow, workflow package, durable
  agents, tool approval, WorkflowChatTransport, use workflow/use step directives,
  or migrating from DurableAgent/ToolLoopAgent. Biases towards ai-sdk.dev/v7 docs
  over pre-trained knowledge.
---

# AI SDK v7 — WorkflowAgent

## Package Versions (current)

| Package | Version | Purpose |
|---------|---------|---------|
| `ai` | 7.x | Core SDK (`tool`, `convertToModelMessages`, `UIMessage`) |
| `@ai-sdk/workflow` | 1.x | `WorkflowAgent`, `WorkflowChatTransport`, `Output` |
| `workflow` | 4.x | DevKit runtime (`getWritable`, `'use workflow'`, `'use step'`) |
| `@ai-sdk/react` | 4.x | `useChat` hook |
| `zod` | 4.x | Tool input schemas |

## When to Use WorkflowAgent vs ToolLoopAgent

| | ToolLoopAgent | WorkflowAgent |
|---|---|---|
| Package | `ai` | `@ai-sdk/workflow` |
| Runtime | In-memory | Workflow (durable) |
| Durability | Lost on crash | Survives restarts |
| Tool retries | Manual | Automatic via `'use step'` |
| Human approval | `toolApproval` | `needsApproval` on tool |
| Primary API | `generate()` / `stream()` | `stream()` only |
| Stream output | `streamText` return | `writable` + `ModelCallStreamPart` |

**Use WorkflowAgent** when: multi-step agents, human-in-the-loop, long-running tasks, production durability.
**Use ToolLoopAgent** when: simple in-memory agents, no durability needed.

## Project Structure

```
src/
├── workflow/agent-chat.ts    # 'use workflow' function with WorkflowAgent
├── tools/steps.ts            # 'use step' durable tool functions
├── app/api/chat/
│   ├── route.ts              # POST — start workflow
│   └── [runId]/stream/route.ts  # GET — resume stream
└── components/chat.tsx       # WorkflowChatTransport + useChat
```

## Core Patterns

### 1. Workflow function

```ts
import { WorkflowAgent, type ModelCallStreamPart } from '@ai-sdk/workflow';
import { convertToModelMessages, tool, type UIMessage } from 'ai';
import { getWritable } from 'workflow';

export async function chat(messages: UIMessage[]) {
  'use workflow';

  const modelMessages = await convertToModelMessages(messages);

  const agent = new WorkflowAgent({
    model: 'anthropic/claude-sonnet-4-6',  // AI Gateway string OR provider instance
    instructions: '...',
    tools: { /* tool definitions */ },
  });

  const result = await agent.stream({
    messages: modelMessages,
    writable: getWritable<ModelCallStreamPart>(),
  });

  return { messages: result.messages };
}
```

### 2. Durable tool steps

```ts
async function myToolStep(input: { key: string }) {
  'use step';  // Makes this a durable workflow step with auto-retry
  return await fetch('...');
}
```

### 3. API route (POST)

```ts
import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { start } from 'workflow/api';

const run = await start(chat, [messages]);
return createUIMessageStreamResponse({
  stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
  headers: { 'x-workflow-run-id': run.runId },
});
```

### 4. Resumable stream (GET)

```ts
import { getRun } from 'workflow/api';

const run = await getRun(runId);
const readable = run.getReadable({ startIndex })
  .pipeThrough(createModelCallToUIChunkTransform());
```

### 5. Client with WorkflowChatTransport

```tsx
import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';

const transport = new WorkflowChatTransport({
  api: '/api/chat',
  maxConsecutiveErrors: 5,
  initialStartIndex: -50,
});
const { messages, sendMessage } = useChat({ transport });
```

### 6. Tool approval (WorkflowAgent-specific)

```ts
bookFlight: tool({
  inputSchema: z.object({ flightId: z.string() }),
  needsApproval: true,  // NOT toolApproval — that's for ToolLoopAgent
  execute: bookFlightStep,
}),
```

### 7. Loop control

```ts
import { isStepCount, isLoopFinished } from 'ai';

await agent.stream({
  messages,
  stopWhen: isStepCount(10),  // NOT maxSteps
});
```

### 8. Context (serializable only)

```ts
const agent = new WorkflowAgent({
  runtimeContext: { tenantId: 't_123' },      // Shared agent state
  toolsContext: { weather: { unit: 'celsius' } }, // Per-tool context
  tools: {
    weather: tool({
      contextSchema: z.object({ unit: z.enum(['celsius', 'fahrenheit']) }),
      execute: async ({ city }, { context }) => ({ city, unit: context.unit }),
    }),
  },
});
```

## Next.js Config

```ts
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@vercel/oidc', 'ajv'],
};
export default withWorkflow(nextConfig);
```

## Documentation

Verify against installed version before implementing:
- Live docs: https://ai-sdk.dev/v7/docs/agents/workflow-agent
- Bundled docs: `node_modules/ai/docs/`, `node_modules/@ai-sdk/workflow/docs/`, `node_modules/workflow/docs/`
- API parameters: [reference.md](reference.md)
