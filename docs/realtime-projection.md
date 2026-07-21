# 实时状态同步设计

Preview / Agent Run / Browser Test 通过统一读模型投影 + Realtime 推送，前端不轮询拼状态。

## 要解决的问题

Preview、Agent run、Browser Test 状态会频繁变。若前端一直 `GET` 拼状态，会：

- 打爆 host（每次现场拼 peek + app-test + run）
- 多 tab / 刷新后状态容易和服务器分叉
- 和「整行推送」的 Realtime 模型不匹配

## 设计：命令与读模型分离

- **写路径**：域更新成功后 `publishRuntimeUpdate`（UI 字段没变就不 bump `version`）
- **读模型**：唯一的 `SessionRuntimeProjection`（`run` / `preview` / `appTest` + 单调 `version`）
- **输送层跟 persist backend**：本地文件 → host SSE；Supabase → Realtime 表 `session_runtime_projection`

前端 `useSessionRuntime`：进页拉一次 `GET /runtime`，之后**整份 projection 替换**（用 `version` 门闸拒绝旧包），不再轮询。

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
      // ... applyProjectionIfNewer ...
    },
  );
```

Daytona 侧 CAS 成功后，会从 snapshot **投影**出 preview 再 publish——Lease 只续租、UI 字段没变时不会刷屏：

```typescript
// Publish UI projection only when derived preview fields change (lease-only CAS no-ops).
void publishPreviewFromSnapshot(saved, ownerId);
```

## 刻意不做的

- 客户端自己 merge `preview.updated`
- 再加一层 Ably / Redis 作为第二条状态总线
- 把 chat token 塞进这条通道（chat 仍走 Workflow SSE）

## 和沙盒调度怎么串起来

```txt
Agent / Preview API
  → ensureDesiredState(desired)     // 声明意图
  → Lease + observe/act             // 单写者收敛沙盒
  → upsertRuntimeSnapshot (CAS)
  → publishRuntimeUpdate            // 投影到 SessionRuntimeProjection
  → Supabase Realtime / SSE         // 前端整份替换
```

**资源调和**管的是「多 isolate 别把沙盒搞炸」；**实时同步**管的是「UI 及时、一致地看见结果」。前者是控制面，后者是读模型推送——拆开是为了让 Serverless 并发和前端体验各自用合适的原语，而不是用轮询或进程内状态硬扛。

**一句话**：沙盒真相在 Daytona runtime snapshot；UI 只订一份投影。云端用 Postgres Realtime 推整行更新，前端不用轮询。
