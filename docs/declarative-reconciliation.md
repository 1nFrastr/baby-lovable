# Declarative resource reconciliation design

## Core insight

This mechanism mainly solves three problems:

1. Multiple requests operating on the same workspace at once, causing duplicate resource creation and state clobbering.
2. Moving scheduling from “the caller decides what to do next” to “the caller declares the final desired state.”
3. Lease controls who may advance real resources; CAS prevents old state from overwriting new state.

## Background

When a user opens a new session, the backend starts warming the workspace: create a sandbox, start the dev server, prepare a PreviewURL. These operations take time.

Meanwhile the Agent may already be working. Before calling tools it needs a usable workspace. If the workspace is not ready yet, the Agent also triggers resource preparation. Worse, the user may not wait patiently and may click Restart repeatedly, trying to restart the whole preview service.

So under the same session, multiple requests may appear at once:

1. Background warm request
2. Agent tool-call request
3. User manual Restart request

They all operate on the same set of resources. Without careful handling, two typical problems appear.

**First: duplicate creation.** For example, the same session starts two sandboxes, or two dev servers. They consume extra resources, may fight over ports, produce multiple PreviewURLs, and leave state unpredictable.

**Second: state clobbering.** For example, the service is already ready, but an earlier request still believes it is not, so it restarts again. The new state is overwritten by an old judgment, and the user experience becomes chaotic.

So what we really need to solve is not a simple “concurrent requests” problem, but:

> Multiple requests make decisions about the same workspace at the same time, and each request may be looking at already-stale state.

## Naive approach: critical-section lock

The most direct approach is locking.

```typescript
lock()
  createSandbox()
  startDevServer()
unlock()
```

This solves part of the problem: at least two requests will not enter this code at the same time, avoiding the most direct concurrent execution. But it still has clear flaws.

A lock only guarantees “only one person executes at a time,” not “what that person is about to do is still correct.” Callers still decide the next action imperatively — create sandbox, start dev server, restart preview. Those decisions usually come from state the caller saw at the time, which may already be stale.

Request A sees the workspace is not ready and plans to create a sandbox. Before A actually runs, request B may already have created it. If A acquires the lock and simply continues the action it decided earlier, it can still duplicate resources.

So a lock only solves “don’t do it at the same time,” not “reconfirm real state before acting.” A larger problem is that state writes can also clobber each other: a request holds an old snapshot and later writes it back to durable storage. If another request has already written newer state in between, that stale write overwrites the new state.

Therefore a pure critical-section lock is not enough. We need more than mutual exclusion — a mechanism that lets the system keep converging around a desired state.

## From imperative to declarative scheduling

The previous pattern was imperative. The caller would say:

> Create a sandbox for me, then start the dev server.

The new pattern is declarative. The caller only says:

> I want this session to reach the preview-ready state.

Whether a sandbox exists, whether the dev server has started, and whether PreviewURL is available are not decided directly by the caller — they are left to the reconciler.

Each time, the reconciler re-observes the real world, then decides the next step: create if there is no sandbox; skip create if one exists; start the dev server if it is down; do nothing if the service is already available; stop when the desired state is satisfied.

That is the shift from imperative to declarative scheduling. Imperative scheduling asks “what command do I run now?” Declarative scheduling asks “what state should we end up in?”

Callers no longer directly orchestrate create, start, and restart. They only write the desired state. The system chooses the minimal action based on the gap between current and desired state, so the real world converges step by step.

## Basic concepts

This mechanism borrows the Kubernetes controller model.

### Desired state

Desired state is what the system wants to become. For example:

```typescript
desired = "preview-ready"
```

It means: I want this session’s preview service to eventually be available.

### Observed state

Observed state is the real situation last observed by the system. For example:

1. Whether the sandbox exists
2. Whether the dev server is started
3. Whether PreviewURL is reachable
4. Whether the phase is creating, starting, ready, or failed

Desired state is “what we want”; observed state is “what it is now.”

### Reconciler

The reconciler advances current state toward desired state. It does not blindly run fixed commands; it repeatedly does three things:

1. Observe the real world
2. Measure the gap between current and desired state
3. Execute one minimal action

This loop continues until the desired state is satisfied or the current reconcile time budget is exceeded.

### Lease

A lease decides who is responsible for reconciliation right now. Multiple requests may enter for the same session, but only one request may actually operate external resources such as sandbox, dev server, and PreviewURL at a time. Whoever holds the lease is the reconciler for this round.

Leases expire. If the isolate holding the lease dies mid-way, the lease does not stick forever. After expiry, another request can take over.

### Version check

Version checks prevent old state from overwriting new state. Every snapshot has a `revision`. On write you must confirm the `revision` still in storage is the one you read.

If the version has changed, someone else already wrote a newer state. The current write must fail; the request re-reads the latest state and decides the next step again. That is what CAS does.

## Reconcile: declarative reconciliation

The new scheduling flow looks like this:

1. The caller writes the desired state, e.g. `preview-ready`
2. The request tries to acquire a lease
3. The lease holder starts reconciling
4. The reconciler observes the real world
5. It executes a minimal action based on observation
6. It observes again
7. Until the desired state is satisfied, or this round times out

Winning the lease is not permission to start and stop resources arbitrarily — it is the right to reconcile. Its only job is:

> Advance current state toward desired state.

If a sandbox already exists, do not create another; if the dev server is already up, do not start it again; if PreviewURL is already available, finish; if the desired state changes mid-reconcile, keep converging toward the new goal.

Requests that do not win the lease need not fail immediately. They can wait for the current reconciler to finish; if the lease expires, the current reconciler may be dead, and they can try to take over.

So the system is no longer multiple requests each running their own procedure — it is multiple requests collaborating around one desired state.

## What Lease solves

Lease solves concurrent operation of external resources. Under the same session, create sandbox, start dev server, and prepare PreviewURL are all external side effects. Running them concurrently easily causes duplicate creation and state clobbering.

Lease’s role is:

1. Only one reconciler can operate external resources at a time
2. If the reconciler dies mid-way, other requests can take over after the lease expires

This differs from an in-process lock. An in-process lock only protects the current process; in Serverless, requests for the same session may land on different isolates. Each isolate has its own memory and cannot rely on a local lock to coordinate.

The lease lives in durable storage, so every isolate sees the same lease state. A lease is also not a permanent lock: it has an expiry and the holder must keep renewing it. While the holder is alive it renews; if the holder dies, renewal stops, the lease expires, and someone else can take over.

Therefore Lease answers:

> Who is allowed to advance the real world.

## What CAS solves

Lease solves who may operate external resources, but not everything. Another failure mode is old state overwriting new state.

For example, request A reads a snapshot:

```typescript
revision = 10
observed = "starting"
```

Then it starts some work. Meanwhile request B finishes a reconcile and updates state to:

```typescript
revision = 11
observed = "ready"
```

If request A later writes back its old snapshot, it may overwrite `ready` with `starting`. That is state clobbering.

CAS prevents this. On every write, the request must carry the `revision` it read. The write succeeds only if durable storage’s current version still equals that `revision`. If the version changed, the write fails; the request must re-read the latest snapshot and re-decide the next action.

So CAS answers:

> Whose state write is still valid.

Lease is about the right to operate external resources; CAS is about whether a state write is still current. They solve different problems; both are required.

## Why not a plain distributed lock

A traditional distributed lock usually means:

> I hold the lock, so I may run this code.

That is still imperative. It can stop two requests from entering a critical section at once, but it does not care whether the action inside is still sensible, or whether the state you write back is based on the latest version.

In this project, the real danger is not simply “two requests running at once.” More specifically, we worry about three things:

1. The same session creates multiple sandboxes
2. An isolate dies mid-way and the coordination flow stalls
3. An isolate holds a stale snapshot and writes old state back to durable storage

Lease solves the first two: only one reconciler advances external resources at a time; because leases expire, someone else can take over after the holder dies. CAS solves the third: every state write must be based on the latest version; if someone already updated the snapshot, a stale write cannot overwrite newer state.

So this mechanism is not “no locks” — it replaces a pure distributed mutex with an expiring lease plus version checks. That fits Serverless concurrency better:

> Multiple requests may declare desired state at once, but only one reconciler advances the real world at a time, and every state write must pass a version check.

## Correspondence to Kubernetes

This model is similar to a Kubernetes controller. In Kubernetes, users usually do not say “go start a container on that machine now”; they declare “I want 3 replicas running.” That desired state is written to the API Server; Controllers keep observing cluster state and create, delete, or update resources so current state approaches desired state.

The same idea applies here. Callers do not directly command sandbox creation or dev server start; they only write a desired state such as `preview-ready`. The system stores two kinds of state: desired and observed. The reconciler keeps observing and taking necessary actions so observed catches up to desired.

Lease is like electing the controller currently responsible for reconciliation. CAS is like etcd’s optimistic concurrency control, ensuring state writes do not clobber each other.

## Code implementation

Core state lives in `DaytonaRuntimeSnapshot`. It only stores desired and observed state; it does not let every API imperatively start or stop the sandbox or dev server.

```typescript
export interface DaytonaRuntimeSnapshot {
  sessionId: string;
  revision: number;
  generation: number;

  desired: DaytonaDesiredState;
  observed: DaytonaObservedPhase;

  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}
```

The important field groups:

- `desired`: target state, e.g. the caller wants preview eventually available
- `observed`: current state from the system’s latest observation of the real world
- `leaseOwner` / `leaseExpiresAt`: who holds the lease and when it expires
- `revision`: used for version checks; on every snapshot write, confirm nobody else updated the version
- `generation`: generation of the desired state; when desired changes, generation changes so the reconciler knows whether it is still working on the latest goal

## ensureDesiredState flow

`ensureDesiredState` can be split into four steps.

**Step 1: write desired state.** For example, if the caller wants preview available:

```typescript
desired = "preview-ready"
```

The caller does not need to know whether a sandbox already exists, or decide whether to start the dev server.

**Step 2: try to acquire a lease.** If nobody is reconciling, or the previous lease has expired, the current request can become the new reconciler. If someone else holds the lease, the current request should not create resources again; it can wait for convergence, or try to take over after expiry.

**Step 3: enter the observe-and-act loop.** The reconciler repeatedly: renew → read latest snapshot → observe the real world → merge observations → check whether desired is satisfied → if not, execute one minimal action.

Simplified code looks like:

```typescript
async function reconcileLoop(...) {
  while (Date.now() < deadline) {
    await renewRuntimeLease(sessionId, owner, LEASE_TTL_MS);

    let snapshot = await getRuntimeSnapshot(sessionId, null, {
      fresh: true,
    });

    const observed = await observeRuntime(...);

    // Merge real observations into the snapshot

    if (isDesiredSatisfied(snapshot)) {
      return snapshot;
    }

    const acted = await reconcileOnce(sessionId, snapshot, observed);

    // If an action ran, continue to the next observation round
  }
}
```

The key point: the reconciler does not execute a one-shot plan from its first judgment. Every round it re-reads the latest snapshot and re-observes the real world, avoiding wrong actions based on stale state.

**Step 4: finish or release the lease.** If desired state is satisfied, this round ends; if the time budget is exceeded, it also stops so later requests can take over.

## What reconcileOnce does

`reconcileOnce` only advances one step. It does not run every action in one go; it picks one minimal action based on the gap between current and desired state.

For example, when desired is `preview-ready`: if there is no sandbox yet, create one; if the sandbox exists but the dev server is down, start it; if the dev server is up but PreviewURL is not ready, wait or refresh; if all conditions are met, do nothing.

Doing “one step at a time” matters. After each action the real world may change; the next step should be decided from a new observation, not by continuing from an old snapshot.

That is the biggest difference between declarative reconciliation and an imperative flow. Imperative looks like:

```typescript
createSandbox()
startDevServer()
createPreviewURL()
```

Declarative reconciliation looks like:

```typescript
observe()

if (!sandboxExists) {
  createSandbox()
  return
}

if (!devServerReady) {
  startDevServer()
  return
}

if (!previewURLReady) {
  preparePreviewURL()
  return
}

return ready
```

After every step, return to observation. Even if another request updated state mid-way, or external resource state changed, the next reconcile round can correct course.

## A typical scenario

Suppose after the user opens a session, background warm starts. It writes desired state:

```typescript
desired = "preview-ready"
```

Then it acquires the lease and starts creating a sandbox. Meanwhile the Agent starts calling tools. The Agent also needs a workspace, so it calls `ensureDesiredState("preview-ready")` as well — but it cannot get the lease.

The Agent does not create another sandbox; it only waits for the current reconciler to advance state to `preview-ready`.

If the background-warm isolate is healthy, it continues creating the sandbox, starting the dev server, and preparing PreviewURL; once desired is satisfied the Agent continues. If that isolate dies mid-way, it stops renewing; after the lease expires, the Agent’s request can take over reconciliation.

After takeover it does not blindly recreate from scratch — it re-observes the real world: reuse the sandbox if it already exists; only start the dev server if needed; finish immediately if PreviewURL is ready. That avoids both duplicate creation and a stuck flow.

## Restart scenario

Restart is the scenario most likely to trigger state races. Users may click Restart repeatedly; each click creates a new intent.

Handled imperatively, every request may stop and start again. When multiple restarts interleave, a service that just started may be stopped again, or an old request may overwrite newer state.

In the declarative model, Restart should not mean “immediately stop then start.” It is more like writing a new desired generation. The system knows:

> The user wants the preview service to converge to available again.

The reconciler decides the next action from the latest generation and real state. If an old reconciler sees the desired generation has changed, it must not keep writing under the old goal; if it tries to write an old snapshot, it fails on revision mismatch. Ultimately only reconcile results based on the latest goal and latest version can write successfully. That reduces state clobbering from rapid Restarts.

## Final model

This mechanism can be summarized in one sentence:

> Callers only declare desired state; the system uses a lease to elect a single reconciler, and version checks to ensure state writes do not overwrite newer results.

More specifically:

1. Callers do not directly create, start, or restart
2. Callers only write desired state
3. Lease decides who currently advances real resources
4. The reconciler keeps observing real state
5. Each round executes only one minimal action
6. CAS ensures an old snapshot cannot overwrite a new snapshot
7. If the reconciler dies, others can take over after the lease expires

Division of labor among Lease, CAS, and Reconciler:

- **Lease**: who may operate external resources at a time, and how takeover works after the holder dies
- **CAS**: how to avoid old versions overwriting new versions on state writes
- **Reconciler**: how current state converges step by step to desired state

The point of this design is not a more complex lock. The real change is moving the system from imperative operations to declarative convergence: callers only express intent; the lease elects the current reconciler; version checks protect state consistency; the reconciler observes, acts, and observes again until the workspace reaches the desired state.
