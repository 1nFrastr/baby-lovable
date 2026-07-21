# 声明式资源调和设计

## 核心洞察

这套机制主要解决三个问题：

1. 多个请求同时操作同一个工作区，导致资源重复创建和状态互相覆盖。
2. 调度方式从「调用方决定下一步做什么」变成「调用方声明最终想要什么状态」。
3. Lease 负责控制谁能推进真实资源，CAS 负责防止旧状态覆盖新状态。

## 背景

当用户打开一个新会话时，后台会开始预热工作区：创建 sandbox、启动 dev server、准备 PreviewURL。这些操作都需要时间。

与此同时，Agent 也可能已经开始工作。它在调用工具之前，需要一个可用的工作区。如果这时工作区还没准备好，Agent 也会触发一遍资源准备流程。更麻烦的是，用户可能没有耐心等待，会连续点击 Restart，试图重启整个预览服务。

于是，同一个 session 下可能同时出现多个请求：

1. 后台预热请求
2. Agent 工具调用请求
3. 用户手动 Restart 请求

它们都在操作同一组资源。如果没有处理好，就会出现两个典型问题。

**第一是重复创建。** 比如同一个 session 启动了两个 sandbox，或者启动了两个 dev server。它们会占用额外资源，也可能抢占端口，生成多份 PreviewURL，最后让状态变得不可预测。

**第二是状态覆盖。** 比如服务已经启动完成了，但另一个较早发起的请求还认为服务没有准备好，于是又执行了一次重启。结果就是，新状态被旧判断覆盖，用户看到的体验会非常混乱。

所以，这里真正要解决的不是简单的「并发请求」问题，而是：

> 多个请求同时围绕同一个工作区做决策，并且每个请求看到的状态都可能已经过期。

## 朴素方案：临界区锁

最直接的做法是加锁。

```typescript
lock()
  createSandbox()
  startDevServer()
unlock()
```

这能解决一部分问题：至少同一时间不会有两个请求同时进入这段代码，能避免最直接的并发执行。但它仍然有明显缺陷。

锁只能保证「同一时间只有一个人在执行」，不能保证「这个人接下来要做的事情是对的」。调用方仍然在命令式地决定下一步动作，比如 create sandbox、start dev server、restart preview。这些判断通常来自调用方当时看到的状态，而这个状态可能已经过期了。

请求 A 看到工作区还没准备好，于是准备创建 sandbox。但在 A 真正执行之前，请求 B 可能已经把 sandbox 创建好了。如果 A 拿到锁后只是继续执行自己一开始决定好的动作，就仍然可能重复创建资源。

所以，锁只解决了「别同时干」，没有解决「干之前要重新确认真实状态」。更大的问题是，状态写入也可能互相覆盖：某个请求手里拿着一份旧的 snapshot，经过一段时间后又把它写回 durable storage。如果这期间已经有别的请求写入了新状态，这次旧写入就会把新状态覆盖掉。

因此，单纯的临界区锁不够。我们需要的不只是互斥，而是一套能让系统围绕目标状态持续收敛的机制。

## 从命令式调度到声明式调度

之前的模式是命令式的。调用方会说：

> 帮我创建 sandbox，然后启动 dev server。

新的模式是声明式的。调用方只说：

> 我希望这个 session 进入 preview-ready 状态。

至于当前有没有 sandbox、dev server 是否已经启动、PreviewURL 是否已经可用，这些都不由调用方直接判断，而是交给调和器完成。

调和器每次都会重新观察真实世界，然后决定下一步要做什么：没有 sandbox 就创建；已存在就不重复创建；dev server 没启动就启动；服务已可用就什么都不做；目标状态已满足就直接结束。

这就是从命令式调度到声明式调度的变化。命令式调度关注「现在执行什么命令？」；声明式调度关注「最终要变成什么状态？」

调用方不再直接编排 create、start、restart 这些动作，只写入目标状态。系统根据当前状态和目标状态之间的差距，自己选择最小动作，让真实世界逐步收敛到目标状态。

## 基础概念

这套机制借鉴了 Kubernetes controller 的模型。

### 目标状态

目标状态表示系统希望变成什么样。例如：

```typescript
desired = "preview-ready"
```

它表达的是：我希望这个 session 的预览服务最终可用。

### 当前状态

当前状态表示系统最近一次观察到的真实情况。例如：

1. sandbox 是否存在
2. dev server 是否启动
3. PreviewURL 是否可访问
4. 当前处于 creating、starting、ready 还是 failed

目标状态是「想要什么」，当前状态是「现在是什么」。

### 调和器

调和器负责把当前状态推进到目标状态。它不会盲目执行固定命令，而是反复做三件事：

1. 观察真实世界
2. 判断当前状态和目标状态的差距
3. 执行一个最小动作

这个过程会不断循环，直到目标状态满足，或者超过本次调和的时间限制。

### 租约

租约用来决定当前由谁负责调和。同一个 session 可能同时有多个请求进来，但同一时间只能有一个请求真正操作 sandbox、dev server、PreviewURL 这些外部资源。拿到租约的人，就是这一轮的调和器。

租约有过期时间。如果持有租约的 isolate 中途挂了，租约不会永久占住。过期之后，其他请求可以接管。

### 版本检查

版本检查用来防止旧状态覆盖新状态。每份 snapshot 都有一个 `revision`。写入时必须确认当前存储里的 `revision` 仍然是自己读到的那个版本。

如果版本已经变化，说明别人已经写入了更新状态。这时当前写入必须失败，然后重新读取最新状态再决定下一步。这就是 CAS 的作用。

## Reconcile：声明式调和

新的调度流程是这样的：

1. 调用方写入目标状态，比如 `preview-ready`
2. 请求尝试获取租约
3. 拿到租约的人开始调和
4. 调和器观察真实世界
5. 根据观察结果执行最小动作
6. 再次观察
7. 直到目标状态满足，或者本轮调和超时

抢到租约的人，并不是获得了「随便起停资源」的权限，而是获得了调和权。它唯一的职责是：

> 让当前状态逐步追上目标状态。

如果 sandbox 已经存在，就不应该再创建；如果 dev server 已经启动，就不应该重复启动；如果 PreviewURL 已经可用，就应该直接结束；如果目标状态在调和过程中变化了，也应该根据新的目标继续收敛。

没有抢到租约的请求也不需要立刻失败。它可以等待当前调和器完成；如果租约过期，说明当前调和器可能已经挂了，它就可以尝试接管。

所以，整个系统不再是多个请求各自执行自己的流程，而是多个请求围绕同一个目标状态协作。

## Lease 解决什么

Lease 解决的是外部资源的并发操作问题。同一个 session 下，创建 sandbox、启动 dev server、准备 PreviewURL 这些操作都属于外部副作用，不能随便并发执行，否则很容易出现重复创建和状态互相覆盖。

Lease 的作用是：

1. 同一时间只有一个调和器能操作外部资源
2. 如果调和器中途挂了，其他请求可以在租约过期后接管

这和普通的进程内锁不一样。进程内锁只能保护当前进程；但在 Serverless 环境里，同一个 session 的请求可能落到不同 isolate 上。每个 isolate 都有自己的内存状态，不能依赖本地锁来协调。

Lease 存在 durable storage 里，所以多个 isolate 都能看到同一份租约状态。Lease 也不是永久锁：它有过期时间，并且需要持有者持续续约。如果持有者还活着，它会不断续约；如果持有者挂了，续约停止，租约过期，别人就可以接手。

因此，Lease 解决的是：

> 谁有资格推进真实世界。

## CAS 解决什么

Lease 解决了谁能操作外部资源，但它没有解决所有问题。还有一种情况是旧状态覆盖新状态。

比如请求 A 读取了一份 snapshot：

```typescript
revision = 10
observed = "starting"
```

然后它开始执行某些操作。与此同时，请求 B 也完成了一次调和，把状态更新成：

```typescript
revision = 11
observed = "ready"
```

如果请求 A 后面又把自己手里的旧 snapshot 写回去，就可能把 `ready` 覆盖回 `starting`。这就是状态覆盖问题。

CAS 用来防止这种情况。每次写入时，请求都必须带上自己读取时的 `revision`。只有 durable storage 里的当前版本仍然等于这个 `revision`，写入才会成功。如果版本已经变了，写入失败；请求需要重新读取最新 snapshot，再重新判断下一步动作。

所以，CAS 解决的是：

> 谁的状态写入仍然有效。

Lease 关注外部资源的操作权，CAS 关注状态写入的新旧关系。两者解决的问题不同，缺一不可。

## 为什么不是普通分布式锁

传统分布式锁通常表达的是：

> 我拿到锁了，所以我可以执行这段代码。

这仍然偏命令式。它能阻止两个请求同时进入临界区，但不关心临界区里执行的动作是否仍然合理，也不关心你写回的状态是不是基于最新版本。

在这个项目里，真正危险的不是单纯的「两个请求同时跑」。更具体地说，我们担心的是三件事：

1. 同一个 session 创建出多个 sandbox
2. 某个 isolate 中途死掉，导致协调流程卡住
3. 某个 isolate 拿着过期 snapshot，把旧状态写回 durable storage

Lease 解决前两个问题：同一时间只有一个调和器推进外部资源；因为租约会过期，持有者挂掉后别人可以接管。CAS 解决第三个问题：每次状态写入都必须基于最新版本；如果有人已经更新过 snapshot，旧写入就不能再覆盖新状态。

所以，这套机制并不是「不要锁」，而是用带过期时间的租约，加上版本检查，来替代单纯的分布式互斥锁。这样更适合 Serverless 场景下的并发模型：

> 多个请求可以同时声明目标，但同一时间只有一个调和器推进真实世界，并且所有状态写入都必须经过版本检查。

## 和 Kubernetes 的对应关系

这套模型和 Kubernetes controller 很像。Kubernetes 里，用户通常不会直接说「现在去某台机器上启动一个容器」，而是声明「我希望有 3 个副本在运行」。这个「希望的状态」会被写入 API Server；Controller 会不断观察集群当前状态，然后创建、删除或更新资源，让当前状态逐渐接近目标状态。

这里也是同样的思路。调用方不直接命令系统创建 sandbox 或启动 dev server，只写入目标状态，比如 `preview-ready`。系统保存两类状态：目标状态和当前状态。调和器不断观察当前状态，并执行必要动作，让当前状态追上目标状态。

Lease 类似于选出当前负责调和的 controller。CAS 类似于 etcd 的乐观并发控制，保证状态写入不会互相覆盖。

## 代码实现

核心状态存放在 `DaytonaRuntimeSnapshot` 里。它只保存目标状态和当前状态，不让每个 API 直接命令式地起停 sandbox 或 dev server。

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

这里最重要的是几类字段：

- `desired`：目标状态，比如调用方希望预览服务最终可用
- `observed`：当前状态，来自系统最近一次对真实世界的观察
- `leaseOwner` / `leaseExpiresAt`：当前谁持有租约，以及租约什么时候过期
- `revision`：用于版本检查；每次写入 snapshot 时，都要确认版本没有被别人更新过
- `generation`：目标状态的代次；当目标状态变化时，generation 会变化，调和器可以据此知道自己正在处理的是不是最新目标

## ensureDesiredState 的流程

`ensureDesiredState` 做的事情可以分成四步。

**第一步，写入目标状态。** 比如调用方希望预览可用，就写入：

```typescript
desired = "preview-ready"
```

调用方不需要关心当前是否已经有 sandbox，也不需要自己决定要不要启动 dev server。

**第二步，尝试获取租约。** 如果当前没有人调和，或者之前的租约已经过期，当前请求就可以成为新的调和器。如果租约已经被别人持有，当前请求不需要重复创建资源；它可以等待状态收敛，或者在租约过期后尝试接管。

**第三步，进入观察和行动循环。** 调和器会反复执行：续约 → 读取最新 snapshot → 观察真实世界 → 合并观察结果 → 判断目标是否已经满足 → 如果没有满足，就执行一个最小动作。

简化后的代码类似这样：

```typescript
async function reconcileLoop(...) {
  while (Date.now() < deadline) {
    await renewRuntimeLease(sessionId, owner, LEASE_TTL_MS);

    let snapshot = await getRuntimeSnapshot(sessionId, null, {
      fresh: true,
    });

    const observed = await observeRuntime(...);

    // 将真实观察结果合并进 snapshot

    if (isDesiredSatisfied(snapshot)) {
      return snapshot;
    }

    const acted = await reconcileOnce(sessionId, snapshot, observed);

    // 如果执行了动作，就继续下一轮观察
  }
}
```

这里最关键的是，调和器不是根据一开始的判断一路执行到底。它每一轮都会重新读取最新 snapshot，并重新观察真实世界，避免基于过期状态继续执行错误动作。

**第四步，结束或释放租约。** 如果目标状态已经满足，本轮调和结束；如果超过时间限制，也会停止，让后续请求继续接管。

## reconcileOnce 做什么

`reconcileOnce` 只负责推进一步。它不会一次性把所有动作都执行完，而是根据当前状态和目标状态之间的差距，选择一个最小动作。

比如目标是 `preview-ready`：当前还没有 sandbox，就创建 sandbox；已有 sandbox 但 dev server 没启动，就启动；dev server 已启动但 PreviewURL 还不可用，就等待或刷新；所有条件都满足，就什么都不做。

这种「一次只做一步」的方式很重要。因为每个动作执行后，真实世界都可能发生变化；下一步应该基于新的观察结果来决定，而不是基于旧 snapshot 继续往下跑。

这也是声明式调和和命令式流程最大的区别。命令式流程像这样：

```typescript
createSandbox()
startDevServer()
createPreviewURL()
```

声明式调和像这样：

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

每一步之后都回到观察阶段。这样即使中途有其他请求更新了状态，或者外部资源状态发生变化，系统也能在下一轮调和中纠正回来。

## 一个典型场景

假设用户打开 session 后，后台预热开始执行。它写入目标状态：

```typescript
desired = "preview-ready"
```

然后它拿到租约，开始创建 sandbox。这时 Agent 也开始调用工具。Agent 发现自己也需要工作区，于是同样调用 `ensureDesiredState("preview-ready")`。但它拿不到租约。

这时 Agent 不会再创建一套 sandbox，只需要等待当前调和器把状态推进到 `preview-ready`。

如果后台预热的 isolate 正常工作，它会继续创建 sandbox、启动 dev server、准备 PreviewURL；Agent 等到目标状态满足后就可以继续执行。如果后台预热的 isolate 中途挂了，它就不会继续续约；租约过期后，Agent 对应的请求可以接管调和。

接管后，它不会从头盲目创建资源，而会重新观察真实世界：sandbox 已经创建好了就复用；dev server 还没启动就只启动；PreviewURL 已经准备好了就直接结束。这样就避免了重复创建，也避免了流程卡死。

## Restart 场景

Restart 是最容易触发状态竞争的场景。用户可能连续点击 Restart，每次点击都会产生一个新的意图。

如果用命令式方式处理，每个请求都可能执行一遍停止和启动。多个 restart 交错执行时，很容易出现服务刚启动又被停止，或者旧请求覆盖新状态的问题。

在声明式模型里，Restart 不应该被理解成「立刻执行 stop 再 start」，更像是写入一个新的目标代次。系统知道：

> 用户希望预览服务重新收敛到可用状态。

调和器会根据最新 generation 和真实状态决定下一步动作。如果旧的调和器发现目标代次已经变化，它就不能继续按旧目标写状态；如果它尝试写入旧 snapshot，也会因为 revision 不匹配而失败。最终，只有基于最新目标和最新版本的调和结果能够写入成功。这样可以减少连续 Restart 带来的状态覆盖问题。

## 最终模型

这套机制可以总结成一句话：

> 调用方只声明目标状态，系统用租约选出唯一调和器，再用版本检查保证状态写入不会覆盖更新结果。

更具体地说：

1. 调用方不直接 create、start、restart
2. 调用方只写入目标状态
3. Lease 决定当前由谁负责推进真实资源
4. 调和器不断观察真实状态
5. 每次只执行一个最小动作
6. CAS 保证旧 snapshot 不能覆盖新 snapshot
7. 如果调和器挂了，租约过期后别人可以接管

Lease、CAS、Reconciler 的分工：

- **Lease**：同一时间谁能操作外部资源，以及持有者挂掉后如何接管
- **CAS**：写入状态时，如何避免旧版本覆盖新版本
- **Reconciler**：如何让当前状态逐步收敛到目标状态

这套方案的重点不是用了一个更复杂的锁。真正的变化是，我们把系统从命令式操作改成了声明式收敛：调用方只负责表达意图；租约负责选出当前的调和器；版本检查负责保护状态一致性；调和器负责观察、行动、再观察，直到工作区进入目标状态。
