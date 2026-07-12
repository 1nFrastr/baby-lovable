# AI SDK v7 WorkflowAgent — API Reference

## WorkflowAgent Constructor Options

```ts
new WorkflowAgent({
  // Required
  model: string | LanguageModel,  // 'anthropic/claude-sonnet-4-6' or openai('gpt-4o')
  tools: Record<string, Tool>,

  // Optional
  instructions: string,
  temperature: number,
  maxOutputTokens: number,
  topP: number,
  toolChoice: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string },
  activeTools: string[],
  timeout: { totalMs?: number; stepMs?: number; chunkMs?: number },

  // Context (must be serializable)
  runtimeContext: Record<string, unknown>,
  toolsContext: Record<string, unknown>,

  // Sandbox
  experimental_sandbox: SandboxSession,

  // Callbacks (constructor-level, also available per-call in stream())
  experimental_onStart: (opts) => void,
  experimental_onStepStart: (opts) => void,
  onToolExecutionStart: (opts) => void,
  onToolExecutionEnd: (opts) => void,
  onStepEnd: (opts) => void,
  onEnd: (opts) => void,
  onError: (opts) => void,

  // Dynamic configuration
  prepareCall: (opts) => Partial<CallSettings>,
  prepareStep: (opts) => Partial<StepSettings>,
  repairToolCall: (opts) => ToolCall | null,
});
```

## agent.stream() Options

```ts
await agent.stream({
  messages: ModelMessage[],          // NOT UIMessage[] — convert first
  writable: WritableStream,          // getWritable<ModelCallStreamPart>()
  stopWhen: StopCondition,           // isStepCount(n) | isLoopFinished()
  output: Output.object({ schema }),  // Structured output
  runtimeContext: Record<string, unknown>,
  toolsContext: Record<string, unknown>,
  experimental_sandbox: SandboxSession,
  prepareCall: (opts) => Partial<CallSettings>,
  prepareStep: (opts) => Partial<StepSettings>,
  // All lifecycle callbacks also available here (per-call)
});
```

Returns: `{ messages: ModelMessage[], output?: T }`

## tool() Definition

```ts
import { tool } from 'ai';
import { z } from 'zod';

tool({
  description: string,
  inputSchema: z.object({ ... }),
  contextSchema: z.object({ ... }),  // Optional per-tool context
  needsApproval: boolean | ((input) => Promise<boolean>),
  execute: async (input, { context, experimental_sandbox }) => result,
});
```

## WorkflowChatTransport Options

```ts
new WorkflowChatTransport({
  api: string,                    // POST endpoint
  maxConsecutiveErrors: number,   // Default: 5
  initialStartIndex: number,      // -50 = fetch last 50 chunks on refresh
});
```

Requires:
- POST returns `x-workflow-run-id` header
- GET at `{api}/{runId}/stream?startIndex=N` for reconnection

## Workflow DevKit Directives

| Directive | Where | Effect |
|---|---|---|
| `'use workflow'` | Top of async function | Marks as durable workflow |
| `'use step'` | Top of async function | Marks as durable step with auto-retry |

## Workflow API (workflow/api)

```ts
import { start, getRun } from 'workflow/api';

// Start a workflow
const run = await start(workflowFn, [arg1, arg2]);
run.runId;       // string
run.readable;    // ReadableStream

// Resume/get existing run
const run = await getRun(runId);
run.getReadable({ startIndex: 0 });  // ReadableStream from index
```

## Type Inference

```ts
import { InferWorkflowAgentUIMessage } from '@ai-sdk/workflow';

const agent = new WorkflowAgent({ ... });
type MyUIMessage = InferWorkflowAgentUIMessage<typeof agent>;
```

## Stream Transform Pipeline

```
WorkflowAgent.stream()
  → writes ModelCallStreamPart to writable
  → run.readable (from workflow)
  → .pipeThrough(createModelCallToUIChunkTransform())
  → createUIMessageStreamResponse() or Response
  → Client receives UIMessageChunk via SSE
```

## Lifecycle Callback Signatures

```ts
experimental_onStart({ modelId, messages })
experimental_onStepStart({ stepNumber })
onToolExecutionStart({ toolCall })
onToolExecutionEnd({ toolCall, toolOutput })
onStepEnd({ usage, finishReason })
onEnd({ steps, totalUsage })
onError({ error })
```

## prepareStep Return Options

```ts
prepareStep: ({ stepNumber, runtimeContext, experimental_sandbox }) => ({
  temperature?: number,
  toolChoice?: 'auto' | 'none' | 'required',
  activeTools?: string[],
  messages?: ModelMessage[],  // Inject/modify messages
  experimental_sandbox?: SandboxSession,
  runtimeContext?: Record<string, unknown>,  // Return new immutable context
})
```
