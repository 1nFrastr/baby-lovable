# Realtime state sync design

Preview, Agent Run, and Browser Test state all change on the server. The frontend should not repeatedly poll multiple endpoints and assemble current state itself. A better approach: the server maintains one unified read model, and the frontend only subscribes to changes of that read model.

In one sentence:

> Truth for sandbox and task state lives on the server; the UI only subscribes to one projected runtime view.

## Problems to solve

In a session, many states change frequently:

- Agent Run is queued, running, completed, or failed
- Preview is creating, starting, restarting, or ready
- Browser Test is running, passed, or failed

If the frontend polls to assemble these states, several problems follow.

**First, high request volume.** Every UI refresh temporarily queries multiple states (run, preview, app test) and assembles them on the server. With multiple tabs open, request volume grows further.

**Second, the frontend easily sees inconsistent state.** On refresh, multi-tab use, or out-of-order network packets, the frontend may overwrite new state with old state, so UI and server truth diverge.

**Third, the sync model is unclear.** Supabase Realtime is better at pushing whole-row changes. If the frontend maintains many partial events and merges them by hand, UI state easily becomes another implicit state machine.

So we need a clear read model:

> The server assembles state; the frontend only receives and replaces.

## Core design

This sync mechanism has two layers:

1. The command side updates real domain state
2. The query side maintains the read model the UI needs

That is: separate the write path from the read model.

## Write path

Domain state is still updated by each domain module. For example:

- Agent Run updates execution status
- Daytona Runtime updates Preview status
- Browser Test updates test status

After those domain updates succeed, they call:

```typescript
publishRuntimeUpdate(...)
```

Its job is not to drive the UI directly, but to convert domain state into the unified view the frontend needs. If the update does not change any UI-relevant fields, `version` is not incremented. For example, lease renewal is only internal coordination and should not force a UI refresh. That reduces useless pushes and avoids the UI being disturbed by internal state churn.

## Read model

The frontend does not subscribe to many scattered events — it subscribes to one unified `SessionRuntimeProjection`. It includes:

- `run`
- `preview`
- `appTest`
- `sourceControl` (Freestyle repo preparation / turn sync status; the chat input still only looks at `run`)
- `version`

`version` is a monotonically increasing version number. Whenever UI-relevant state changes, the server builds a new projection and increments `version`.

After receiving a projection, the frontend does not partially merge — it replaces the whole document. If the incoming `version` is older than the current one, it is discarded. That prevents out-of-order network delivery from overwriting newer state with older state.

## Transport

Local and cloud use the same channel:

```txt
Supabase Postgres → Supabase Realtime → Web UI
```

The table is `session_runtime_projection`. The frontend subscribes to the row for the current session.

## How the frontend consumes it

The frontend consumes runtime state via `useSessionRuntime`. On page entry it fetches initial state once:

```txt
GET /runtime
```

After that there is no polling; all later changes arrive via Realtime. Simplified code:

```typescript
const channel = supabase
  .channel(`runtime:${sessionId}`)
  .on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "session_runtime_projection",
      filter: `session_id=eq.${sessionId}`,
    },
    (payload) => {
      // applyProjectionIfNewer(payload)
    },
  );
```

Core logic:

```txt
if incoming.version > current.version:
  replace projection
else:
  ignore
```

In other words, the frontend does not need to understand how to merge each event. It only checks version, then accepts a new complete state.

## How Preview state is published

Preview’s real state comes from the Daytona runtime snapshot. After each successful CAS write on the Daytona side, UI-needed preview state is projected from the snapshot and published to `SessionRuntimeProjection`.

```typescript
// Publish UI projection only when derived preview fields change.
// Lease-only CAS no-ops should not trigger UI updates.
void publishPreviewFromSnapshot(saved, ownerId);
```

An important constraint:

> Publish a new projection only when UI-visible fields change.

For example, lease renewal, internal owner changes, or fields used only for coordination should not deliver a new state to the frontend.

What the frontend cares about: whether Preview is ready, PreviewURL, whether it is starting / restarting / failed, and whether there is a displayable error. It does not care who holds the Lease, when the Lease expires, or whether a CAS was only a renewal. That separates control-plane state from UI state.

## Why not let the client merge

A seemingly simple approach is: the backend pushes partial events like `preview.updated`, `run.updated`, `appTest.updated`, and the frontend merges them. We do not do that, because it moves complexity to the client.

The client would have to handle: out-of-order events, missing partial state, restoring initial state after refresh, multi-tab consistency, and dependencies between events. The frontend easily becomes an implicit state machine.

So we choose to assemble the full projection on the server. The frontend only receives the complete read model and decides whether to apply it via `version`. Sync semantics stay simple:

> The server produces facts; the frontend displays the latest fact.

## What we deliberately do not do

### No client-side merge of partial events

The client does not handle partial patches like `preview.updated`; it only receives a full `SessionRuntimeProjection`.

### No second state bus

We do not add Ably, Redis Pub/Sub, or another messaging system as a second UI state channel. State already lives in Postgres; Realtime can push table changes directly. Another state bus would add consistency cost.

### Do not mix chat tokens into the runtime channel

Agent streaming text still goes through Workflow SSE. Runtime projection only covers structured state such as Preview, Run, and Browser Test. Those two data types have different lifecycles and consumption patterns and should not share one channel.

## Relationship to sandbox scheduling

Sandbox scheduling converges real resources; realtime sync lets the UI see the convergence result. The full path:

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

The first half is the control plane:

```txt
ensureDesiredState
  → Lease
  → observe/act
  → CAS
```

It solves: when multiple isolates operate the same sandbox at once, how to avoid duplicate creation and state clobbering.

The second half is read-model push:

```txt
publishRuntimeUpdate
  → SessionRuntimeProjection
  → Realtime
```

It solves: how the frontend sees server runtime state promptly and consistently.

Splitting these keeps system boundaries clear. Resource reconciliation does not drive the UI directly; the UI does not infer resource state itself. Reconciliation only advances the real world to desired state; realtime projection only converts current runtime into the display state the frontend needs.

## Summary

The core of this realtime sync design is:

> The server maintains a unified read model; the frontend subscribes to the full projection and uses version to prevent old state from overwriting new state.

Specifically:

- Preview, Agent Run, and Browser Test are projected into one `SessionRuntimeProjection`
- On page entry the frontend fetches initial state once, then receives updates via Realtime
- Each update replaces the whole projection; the client does not partially merge
- `version` rejects out-of-order or stale state packets
- Internal coordination such as lease renewal does not trigger UI refresh
- Chat tokens still use Workflow SSE and are not mixed into the runtime channel

The end result:

> The backend produces a consistent runtime view; the frontend only displays the latest version.
