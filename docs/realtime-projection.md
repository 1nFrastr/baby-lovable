# 实时状态同步设计

Preview、Agent Run、Browser Test 的状态都在服务端变化。前端不应该反复轮询多个接口，然后自己拼出当前状态。更合理的方式是：服务端维护一份统一的读模型，前端只订阅这份读模型的变化。

一句话概括：

> 沙盒和任务状态的真相在服务端，UI 只订阅一份投影后的运行态视图。

## 要解决的问题

在一个会话里，很多状态都会频繁变化：

- Agent Run 正在排队、执行、完成或失败
- Preview 正在创建、启动、重启或就绪
- Browser Test 正在运行、通过或失败

如果前端通过轮询来拼这些状态，会带来几个问题。

**第一，请求量高。** 每次刷新 UI 都要临时查询多份状态（run、preview、app test），再在服务端现场拼装。多个 tab 同时打开时，请求量会进一步放大。

**第二，前端容易看到不一致状态。** 用户刷新页面、多 tab 同时存在、网络包乱序到达时，前端可能会用旧状态覆盖新状态，导致 UI 和服务端真实状态分叉。

**第三，状态同步模型不清晰。** Supabase Realtime 更适合推送一整行数据变化。如果前端自己维护多个局部事件再手动 merge，很容易让 UI 状态变成另一套隐式状态机。

所以这里需要一个明确的读模型：

> 服务端负责拼好状态，前端只负责接收和替换。

## 核心设计

这套同步机制分成两层：

1. 命令侧负责更新真实业务状态
2. 查询侧负责维护 UI 需要的读模型

也就是把写路径和读模型分开。

## 写路径

业务状态仍然由各自的领域模块更新。比如：

- Agent Run 更新执行状态
- Daytona Runtime 更新 Preview 状态
- Browser Test 更新测试状态

这些领域状态更新成功后，会调用：

```typescript
publishRuntimeUpdate(...)
```

它的作用不是直接驱动 UI，而是把领域状态转换成前端需要的统一视图。如果这次更新没有改变任何 UI 关心的字段，就不会递增 `version`。例如 Lease 续租只是内部协调状态，不需要通知前端刷一遍。这样可以减少无意义推送，避免 UI 被内部状态变化频繁打扰。

## 读模型

前端订阅的不是多个零散事件，而是一份统一的 `SessionRuntimeProjection`。它包含：

- `run`
- `preview`
- `appTest`
- `version`

其中 `version` 是单调递增的版本号。每次 UI 相关状态发生变化，服务端都会生成一份新的 projection，并递增 `version`。

前端收到 projection 后，不做局部 merge，而是整份替换。如果收到的 `version` 比当前版本旧，就直接丢弃。这样可以避免网络乱序导致旧状态覆盖新状态。

## 输送层

投影后的读模型会根据不同持久化后端走不同通道。

本地开发时：

```txt
local file store → host SSE → Web UI
```

云端部署时：

```txt
Supabase Postgres → Supabase Realtime → Web UI
```

云端使用的表是 `session_runtime_projection`。前端订阅这张表中当前 session 对应的行。

## 前端消费方式

前端通过 `useSessionRuntime` 消费运行态。进入页面时，先拉取一次初始状态：

```txt
GET /runtime
```

之后不再轮询，所有后续变化都通过 Realtime 推送。简化代码如下：

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

核心逻辑是：

```txt
if incoming.version > current.version:
  replace projection
else:
  ignore
```

也就是说，前端不需要理解每个事件如何合并。它只需要判断版本，然后接受一份新的完整状态。

## Preview 状态如何发布

Preview 的真实状态来自 Daytona runtime snapshot。Daytona 侧每次 CAS 写入成功后，会从 snapshot 中投影出 UI 需要的 preview 状态，然后发布到 `SessionRuntimeProjection`。

```typescript
// Publish UI projection only when derived preview fields change.
// Lease-only CAS no-ops should not trigger UI updates.
void publishPreviewFromSnapshot(saved, ownerId);
```

这里有一个重要约束：

> 只有 UI 可见字段变化时，才发布新的 projection。

例如租约续期、内部 owner 变化、仅用于协调的字段更新，都不应该让前端收到一条新状态。

前端关心的是：Preview 是否 ready、PreviewURL、当前是否 starting / restarting / failed、是否有可展示的错误信息。前端不关心当前 Lease holder、Lease 过期时间，或某次内部 CAS 是否只是续租。这样可以把控制面状态和 UI 状态隔离开。

## 为什么不让客户端自己 merge

一个看似简单的方案是：后端推送 `preview.updated`、`run.updated`、`appTest.updated` 这类局部事件，然后前端自己合并。这里没有这么做，原因是这样会把复杂度转移到客户端。

客户端需要处理：事件乱序、局部状态缺失、页面刷新后的初始状态恢复、多 tab 下的状态一致性、不同事件之间的依赖关系。最后前端很容易变成一个隐式状态机。

所以这里选择服务端拼好整份 projection。前端只接收完整读模型，并根据 `version` 判断是否应用。这让同步语义更简单：

> 服务端负责生成事实，前端负责展示最新事实。

## 刻意不做的事情

### 不在客户端 merge 局部事件

客户端不处理 `preview.updated` 这类局部 patch，只接收完整的 `SessionRuntimeProjection`。

### 不再引入第二条状态总线

没有额外引入 Ably、Redis Pub/Sub 或其他消息系统作为第二条 UI 状态通道。状态已经落在 Postgres 中，Realtime 可以直接推送表变化。再加一层状态总线会增加一致性成本。

### 不把 chat token 混进运行态通道

Agent 的流式文本仍然走 Workflow SSE。运行态投影只负责 Preview、Run、Browser Test 这些结构化状态。这两类数据的生命周期和消费方式不同，不应该混在一条通道里。

## 和沙盒调度的关系

沙盒调度负责让真实资源收敛，实时同步负责让 UI 看到收敛结果。完整链路如下：

```txt
Agent / Preview API
  → ensureDesiredState(desired)
  → Lease + observe/act
  → upsertRuntimeSnapshot(CAS)
  → publishRuntimeUpdate
  → SessionRuntimeProjection
  → Supabase Realtime / SSE
  → Web UI
```

前半段是控制面：

```txt
ensureDesiredState
  → Lease
  → observe/act
  → CAS
```

它解决的是：多个 isolate 同时操作同一个沙盒时，如何避免重复创建和状态覆盖。

后半段是读模型推送：

```txt
publishRuntimeUpdate
  → SessionRuntimeProjection
  → Realtime
```

它解决的是：前端如何及时、一致地看到服务端运行状态。

这两件事拆开，是为了让系统边界更清晰。资源调和不直接驱动 UI，UI 也不直接推断资源状态。资源调和只负责把真实世界推进到目标状态；实时投影只负责把当前运行态转换成前端需要的展示状态。

## 总结

这套实时同步设计的核心是：

> 服务端维护统一读模型，前端订阅整份 projection，并用 version 防止旧状态覆盖新状态。

具体来说：

- Preview、Agent Run、Browser Test 被投影成同一份 `SessionRuntimeProjection`
- 前端进页只拉一次初始状态，之后通过 Realtime 接收更新
- 每次更新都是整份 projection 替换，而不是客户端局部 merge
- `version` 用来拒绝乱序或过期的状态包
- Lease 续租等内部协调变化不会触发 UI 刷新
- Chat token 仍然走 Workflow SSE，不混入运行态通道

最终效果是：

> 后端负责生成一致的运行态视图，前端只负责展示最新版本。
