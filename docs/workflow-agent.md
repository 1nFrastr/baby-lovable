# Workflow Agent design

BabyLovable uses Vercel AI SDK v7 `WorkflowAgent` and Serverless Workflow to run recoverable long-task Agents in a Serverless environment.

In one sentence:

> Agent execution is not bound to a single HTTP request; it is split into durable, recoverable, and retryable workflow steps.

## Problems to solve

A Coding Agent turn is rarely finished with one model call. It may need many consecutive steps:

- Understand the user request
- Read project files
- Edit source
- Install dependencies
- Start or check Preview
- Open a browser to accept results
- Keep fixing based on errors
- Sync final state to the frontend

These operations take time and can fail in the middle. Putting a whole turn in one ordinary HTTP request causes several problems.

**First, request lifecycles are too short.** Serverless requests are a poor fit for long occupancy. One Agent turn may last tens of seconds or longer and cannot depend on a single request staying alive.

**Second, page connections are unreliable.** Users may refresh, switch tabs, or lose network. If the output stream is bound only to the current connection, recovery after disconnect is hard.

**Third, failure recovery is expensive.** If a tool call fails (dependency install, Preview check, browser test), the system should retry near the failed step rather than re-run the whole conversation from scratch.

So what is needed is not an ordinary chat API, but a recoverable Agent Workflow.

## Core design

BabyLovable uses `WorkflowAgent` to orchestrate one Agent turn. A turn is split into observable steps; each step’s execution state is saved by the Workflow runtime, not only in the current isolate’s memory.

Benefits:

- Agent execution does not depend on a single HTTP request lifecycle
- Output can still be recovered after a page refresh
- Failed steps can be retried under Workflow semantics
- Tool calls can be observed and debugged
- Web and CLI can share the same Agent capabilities

## Durable execution

In a plain Serverless model, after a request ends, memory state in the current isolate is unreliable. Agent work needs to span many async steps.

BabyLovable places Agent execution inside a Serverless Workflow. The Workflow runtime records step state, progress, and failure information.

That means:

> Agent progress belongs to the Workflow, not to a live HTTP request.

Even if a connection drops or an isolate is gone, later requests can still resume execution or keep observing results from durable Workflow state.

## Recoverable streams

What users see in the Web UI is an Agent output stream, but that stream must not depend only on the current browser connection. If the user refreshes, the system needs to:

> Let the new page reconnect to the current session’s output and state.

BabyLovable recovers session streams via Workflow transport. When the frontend re-enters a session, it can restore display from existing Workflow state and message history instead of starting a new Agent run. The experience is closer to a continuously running task than a fragile HTTP stream.

## Tool isolation

The Agent orchestration layer should not care how each tool is implemented. BabyLovable splits tool capabilities out and exposes them as independent tools / steps. Typical tools include:

- File read / write
- Directory listing
- Dependency install
- Preview check
- Browser Test
- Sandbox-related operations

Orchestration decides when to call tools; the tool layer performs the side effects. That lets the Agent system prompt, tool definitions, sandbox implementation, and UI sync evolve independently without tight coupling.

## Relationship to declarative resource reconciliation

The Agent needs Preview, but it should not imperatively create a sandbox or start a dev server. In other words, the Agent should not do this:

```txt
createSandbox
startDevServer
createPreviewURL
```

It should only declare the desired state it needs:

```txt
preview-ready
```

Preview lifecycle is owned by the sandbox scheduling layer. That layer decides whether to create a sandbox, start the dev server, or refresh PreviewURL until the desired state is satisfied.

So the relationship between Agent and sandbox is:

```txt
Agent declares need for preview-ready
  → Runtime scheduling layer converges
  → Agent continues after Preview is available
```

That avoids duplicate creation and state clobbering when multiple Agent tool calls, background warm, and user Restart all operate on the sandbox at once.

See: [Declarative resource reconciliation design](./declarative-reconciliation.md)

## Verification loop

In BabyLovable the Agent does more than write code. Tools form a full feedback loop:

```txt
Edit source
  → checkPreview
  → Browser Test
  → Keep fixing from feedback
```

For example, after editing a page the Agent can first check whether Preview is available. If Preview fails to start, it can read the error and fix code; if Preview is available, it can open a browser, observe rendering, and iterate from test feedback.

That shifts the Agent from “generate code” to “generate → run → check → fix.” That closed loop is central to a cloud Coding Agent.

## Host vs Workspace boundary

BabyLovable splits the system into two parts:

```txt
Host
  → Agent orchestration
  → Workflow
  → Tools
  → State sync

Workspace / Sandbox
  → User project
  → Source files
  → Dependencies
  → dev server
  → Preview
```

Host-layer code mainly lives under:

```txt
src/workflow/
src/tools/
src/cli/
```

It owns Agent orchestration, tool definitions, runtime state, and external APIs. Each session’s generated app runs in an independent Daytona workspace. User projects stay isolated from the Host system, and sessions do not contaminate each other.

## Web and CLI share the same Agent

Besides the Web UI, BabyLovable provides a headless CLI. CLI and Web share:

- The same Agent
- The same tools
- The same system prompt
- The same workspace logic

That enables end-to-end verification without opening a browser. Many Agent issues come from tools, prompts, sandbox state, or workflow orchestration — not from the UI. The CLI removes the Web UI from the debug path so issues are easier to locate.

See: [Local development guide](./local-development.md)

## Related entry points

| Path | Role |
| --- | --- |
| `src/workflow/builder-agent.ts` | Shared `WorkflowAgent` and system prompt |
| `src/workflow/builder-chat.ts` | Durable web workflow with `'use workflow'` entry |
| `src/tools/builder-tools.ts` | Agent tool surface definitions |
| `src/cli/` | Headless runner sharing the same Agent as Web |

## Summary

The core of this Workflow Agent design is:

> Use Workflow to carry long Agent tasks, Tools to isolate side effects, and recoverable streams to connect the Web UI.

Specifically:

- Agent work does not depend on finishing in one HTTP request
- Workflow stores step state, progress, and failure info
- Session output can be recovered after page refresh
- Tool calls are decoupled from Agent orchestration
- Preview converges declaratively via the sandbox scheduling layer
- Agent can form a verification loop with Preview and Browser Test
- CLI and Web share the same Agent for easier end-to-end regression

The end result:

> An Agent is not a single chat request — it is a cloud workflow that can keep running, recovering, observing, and verifying.
