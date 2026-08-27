<div align="center">
<img src="public/brand/icon.png" alt="BabyLovable" width="80" height="80" />

<h2>BabyLovable</h2>

<h3>
  Multi-user coding agent, built for serverless
  |
  <a href="https://baby-lovable.vercel.app/">Demo ↗</a>
</h3>

<a href="https://vercel.com/blog/ai-sdk-7"><img src="https://img.shields.io/badge/Vercel_AI-SDK_v7-000000?logo=vercel&logoColor=white"></a>
<a href="https://ai-sdk.dev/docs/agents/workflow-agent#workflowagent"><img src="https://img.shields.io/badge/Vercel_Workflow-Agent-000000?logo=vercel&logoColor=white"></a>
<a href="https://www.daytona.io/"><img src="https://img.shields.io/badge/Daytona-Sandbox-000000"></a>
<a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white"></a>
<a href="https://supabase.com/docs/guides/auth"><img src="https://img.shields.io/badge/Supabase-Auth-3ECF8E?logo=supabase&logoColor=white"></a>
<a href="https://supabase.com/docs/guides/realtime"><img src="https://img.shields.io/badge/Supabase-Realtime-3ECF8E?logo=supabase&logoColor=white"></a>
<a href="https://developers.cloudflare.com/browser-rendering/"><img src="https://img.shields.io/badge/Cloudflare-Browser_Run-F38020?logo=cloudflare&logoColor=white"></a>
</div>

## What is BabyLovable

BabyLovable is a multi-user Coding Agent that runs on a Serverless architecture.

Users can describe requirements in the browser; the Agent generates and edits projects in a remote sandbox, starts a development server, provides a live Preview, and can automatically open a browser to verify the results.

The focus of this project is not only to recreate a Lovable-style product, but to explore:

> How to reliably orchestrate long-running Agent tasks, remote development sandboxes, multi-user state sync, and automated acceptance checks in a Serverless environment.

## Core capabilities

| Capability | Value |
| --- | --- |
| **Cloud Coding Agent** | Users need no local environment; generate, edit, and preview projects directly in the browser |
| **Durable workflows** | Agent runs can be interrupted, resumed, and retried on failure |
| **Recoverable session streams** | Agent output and session state survive page refreshes |
| **Remote sandbox Preview** | Each session gets an independent sandbox with a managed dev server and live preview |
| **Declarative sandbox scheduling** | When multiple requests fire at once, avoid duplicate sandbox creation and state clobbering |
| **Realtime state sync** | Preview, Agent Run, and Browser Test status are pushed to the frontend via Realtime |
| **Automated browser acceptance** | The Agent can open a browser and inspect the pages it generated |
| **Multi-user isolation** | Supabase Auth and RLS isolate user data and session resources |

## Design highlights

### 1. Durable Agent Workflow on Serverless

Ordinary request lifecycles are a poor fit for long-running Agent tasks.

BabyLovable uses Vercel AI SDK v7 `WorkflowAgent` to orchestrate Agent execution, splitting work into observable, recoverable, and retryable steps.

Even if the page refreshes, the connection drops, or a step fails, the system can recover from durable state instead of depending on a single HTTP request to finish all logic.

See: [Workflow Agent design](./docs/workflow-agent.md)

### 2. Declarative resource reconciliation, not imperative procedures

In a Serverless environment, the same session may be triggered by multiple isolates at once:

- The user opens Preview
- The Agent calls tools
- Background warm of the workspace
- The user clicks Restart

If every request directly creates a sandbox or starts a dev server, you easily get duplicate creation, port conflicts, and state clobbering.

BabyLovable does not let callers imperatively run `create` / `start`.  
Callers only declare a desired state, for example:

```ts
desired = "preview-ready"
```

The system reconciles continuously, similar to a Kubernetes controller:

```txt
observe → act → observe → act
```

Lease elects the single current reconciler.  
CAS prevents an old snapshot from overwriting newer state.

See: [Declarative resource reconciliation design](./docs/declarative-reconciliation.md)

### 3. Realtime state projection instead of frontend polling

Preview, Agent Run, and Browser Test state change frequently.

BabyLovable does not make the frontend poll many endpoints and assemble state itself. Instead, the server maintains a unified `SessionRuntimeProjection`.

When backend state changes, the runtime is projected into the read model the frontend needs, then the whole row is pushed via Supabase Realtime.

On page entry the frontend fetches initial state once, then only receives Realtime updates, rejecting stale packets with a monotonic `version`.

This reduces polling pressure and avoids state forks across multiple tabs and refreshes.

See: [Realtime state sync design](./docs/realtime-projection.md)

### 4. Agent automated browser acceptance

With Cloudflare Browser Rendering integrated, the Agent can open the Preview page, inspect rendering results, and keep fixing based on that feedback — a closed loop of generate → preview → accept.

## Architecture overview

```txt
User
  ↓
Next.js App
  ↓
WorkflowAgent
  ↓
Tool Calls
  ↓
Daytona Sandbox
  ↓
Dev Server / PreviewURL
  ↓
Browser Test
```

Runtime sync path:

```txt
Agent / Preview API
  → ensureDesiredState(desired)
  → Lease + observe/act
  → upsertRuntimeSnapshot(CAS)
  → publishRuntimeUpdate
  → SessionRuntimeProjection
  → Supabase Realtime
  → Web UI
```

Resource reconciliation keeps the remote sandbox converging stably.  
Realtime projection keeps the frontend seeing timely, consistent state changes.

Splitting these two concerns avoids leaning on polling, in-process state, or a single request lifecycle to survive Serverless concurrency.

## Tech stack

| Module | Technology |
| --- | --- |
| App | Next.js 16 |
| Agent | Vercel AI SDK v7 `WorkflowAgent` |
| Workflow | Vercel Workflow / Serverless Workflow |
| Sandbox | Daytona Sandbox + custom image |
| Auth | Supabase Auth |
| Realtime | Supabase Realtime |
| Database | Supabase Postgres |
| Browser Test | Cloudflare Browser Rendering |
| UI Sync | SessionRuntimeProjection + Realtime |

## Local development

- Local and production both use Supabase for metadata storage and Realtime
- Local and production both use Daytona Sandbox + Freestyle `main`
- Local development requires Supabase Auth, database, and a CLI user
- CLI end-to-end verification is supported; there is no local sandbox simulation branch

See: [Local development guide](./docs/local-development.md)

## Docs

- [Declarative resource reconciliation design](./docs/declarative-reconciliation.md)
- [Freestyle Git persistence design](./docs/freestyle-git.md)
- [Realtime state sync design](./docs/realtime-projection.md)
- [Workflow Agent design](./docs/workflow-agent.md)
- [Local development guide](./docs/local-development.md)

## Roadmap

- [ ] Agent Runtime governance: long-context management, tool-result compression, etc.
- [ ] Product experience: UI / UX improvements
- [ ] Third-party connectors: Supabase BaaS, Vercel Deploy, image-generation MCP tools, etc.
