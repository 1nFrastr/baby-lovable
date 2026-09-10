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

BabyLovable uses Vercel AI SDK v7 `WorkflowAgent` to orchestrate Agent execution, splitting work into recoverable and retryable steps.

Even if the page refreshes, the connection drops, or a step fails, the system can recover from durable state instead of depending on a single HTTP request to finish all logic.

Workflow observability here is **run/step durability** (resume, retry, inspect whether a step succeeded). It is not agent-quality eval: it does not tell you whether the turn actually finished the user's task, which tools mattered, or how a prompt/model change compares to a baseline. Today that gap is only partly covered by `[agent-trace]` stdout and CLI `agent.log`. A dedicated eval observability layer is on the roadmap.

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
- Prefer Docker `supabase start` + Studio for isolated DB debugging (see [Local Supabase](./docs/local-supabase.md))
- CLI end-to-end verification is supported; there is no local sandbox simulation branch

See: [Local development guide](./docs/local-development.md) · [Local Supabase + Studio](./docs/local-supabase.md)

## Docs

- [Declarative resource reconciliation design](./docs/declarative-reconciliation.md)
- [Freestyle Git persistence design](./docs/freestyle-git.md)
- [Realtime state sync design](./docs/realtime-projection.md)
- [Workflow Agent design](./docs/workflow-agent.md)
- [Local development guide](./docs/local-development.md)
- [Local Supabase + Studio](./docs/local-supabase.md)
- [Supabase migrations](./docs/supabase-migrations.md)

## Roadmap

Done:

- [x] Agent Runtime governance: long-context, tool-result compression, `/summarize`
- [x] Product experience: chat, Preview, files, History (read-only), GitHub Sync

Next, in order:

**1. Agent capabilities** — Still a single builder with a fixed tool set.

- [x] Multimodal input (images and documents in chat; screenshot / design → edit)
- [ ] Plan mode and todos: plan before implementing, keep a visible task list across steps
- [ ] Web search: look up current docs, APIs, and examples while building
- [ ] Skills (session-level playbooks)
- [ ] Memory: durable session / user memory beyond compaction summaries
- [ ] External context: pull in Google Docs, Drive, Notion (and similar) via connectors / MCP
- [ ] MCP as the connector bus (deploy, images, BaaS, docs) instead of one-off tools
- Later: subagents (explore / implement / verify) — highest cost on WorkflowAgent

**2. Visual Edit** — Preview iframe bridge exists (location / back-forward / Visual Picker).

- [x] Visual picker: click a DOM node in Preview → chip in the composer (pick-to-chat)
- Later: screenshot of the node, DOM → source mapping, inline style edits

**3. Build & Ship** — Today: Next.js starter only; Preview dies with the sandbox.

- [ ] Publish: one-click deploy from Freestyle `main` to a durable public URL
- [ ] Generated-app backend: Auth, DB, Storage, Edge Functions
- [ ] Payments (Stripe) so generated apps can charge money
- [ ] Security gate before publish: secrets in git, `npm audit`, dangerous APIs (not a standalone scanner product)
- Later: mobile (Expo / RN) as a second runtime — new snapshot, no iframe picker; do not start until Web can ship and take payment

**4. Time travel** — Freestyle per-turn checkpoints already exist; History cannot restore yet.

- [ ] Restore workspace + Preview from a checkpoint (code only; do not rewind chat)

**5. Eval observability** — Vercel Workflow's own observability is still too weak for this product. The dashboard and step UI show that a workflow ran or retried; they do not score agent quality, persist structured traces, or compare prompt / model / tool-set changes. `[agent-trace]` stdout and CLI `agent.log` are grep-friendly, but they are not an eval system.

- [ ] Persist structured turn traces independently of Workflow (steps, tools, tokens, preview / browser outcomes)
- [ ] Turn-level scores: task completion, compile health, `checkPreview`, browser accept, incomplete turns
- [ ] Offline eval from production traces: prompt / model / tool-set diffs vs a baseline
- [ ] Online monitoring of live sessions (not only local CLI logs)
