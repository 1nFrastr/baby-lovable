<div align="center">
<img src="public/brand/icon.png" alt="BabyLovable" width="80" height="80" />

<h2>BabyLovable</h2>

<h3>
  Serverless 架构下的云端多用户 Coding Agent
  ·
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

## BabyLovable 是什么

BabyLovable 是一个运行在 Serverless 架构上的云端多用户 Coding Agent。

用户可以在浏览器里发起需求，Agent 会在远程沙盒中生成和修改项目，启动开发服务，提供实时 Preview，并可以自动打开浏览器验证结果。

这个项目重点不只是复刻一个 Lovable 类产品，而是探索：

> 在 Serverless 环境下，如何可靠地编排长时间 Agent 任务、远程开发沙盒、多用户状态同步和自动化验收。

## 核心能力

| 能力 | 价值 |
| --- | --- |
| **云端 Coding Agent** | 用户无需本地环境，直接在浏览器中生成、修改和预览项目 |
| **持久工作流** | Agent 执行过程可中断、可续跑、失败可重试 |
| **可恢复会话流** | 页面刷新后仍能恢复 Agent 输出和会话状态 |
| **远程沙盒 Preview** | 每个会话拥有独立 sandbox，支持启动 dev server 和实时预览 |
| **声明式沙盒调度** | 多个请求同时触发时，避免重复创建 sandbox 和状态互相覆盖 |
| **实时状态同步** | Preview、Agent Run、Browser Test 状态通过 Realtime 推送到前端 |
| **自动浏览器验收** | Agent 可以打开浏览器检查自己生成的页面结果 |
| **多用户隔离** | 基于 Supabase Auth 和 RLS 隔离用户数据与会话资源 |

## 功能演示

<table>
  <tr>
    <td align="center" valign="top" width="50%">
      <p><strong>基础能力</strong></p>
      <video src="https://github.com/user-attachments/assets/df081939-f3ec-44fb-ba3f-13a68d9ce010" width="420" controls muted></video>
    </td>
    <td align="center" valign="top" width="50%">
      <p><strong>可恢复流</strong></p>
      <video src="https://github.com/user-attachments/assets/2eca82e8-ebeb-4bcb-b359-abd4bcb76b98" width="420" controls muted></video>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" width="50%">
      <p><strong>自动化浏览器测试</strong></p>
      <video src="https://github.com/user-attachments/assets/3d307aae-430f-4a4d-8659-d11ce6f7f050" width="420" controls muted></video>
    </td>
    <td align="center" valign="top" width="50%">
      <p><strong>持久工作流</strong></p>
      <video src="https://github.com/user-attachments/assets/1a0d6756-facb-4094-a883-4422a742bee9" width="420" controls muted></video>
    </td>
  </tr>
</table>

## 设计亮点

### 1. Serverless 上的持久 Agent Workflow

普通请求生命周期不适合承载长时间 Agent 任务。

BabyLovable 使用 Vercel AI SDK v7 的 `WorkflowAgent` 编排 Agent 执行过程，将任务拆成可观测、可恢复、可重试的步骤。

这样即使页面刷新、连接中断，或者某个步骤失败，系统也可以从持久化状态中恢复，而不是依赖单次 HTTP 请求跑完所有逻辑。

详见：[Workflow Agent 设计](./docs/workflow-agent.md)

### 2. 声明式沙盒生命周期调度

在 Serverless 环境里，同一个会话可能被多个 isolate 同时触发：

- 用户打开 Preview
- Agent 调用工具
- 后台 warm 工作区
- 用户点击 Restart

如果每个请求都直接创建 sandbox 或启动 dev server，很容易出现重复创建、端口冲突和状态覆盖。

BabyLovable 不让调用方直接命令式地执行 `create` / `start`。  
调用方只声明目标状态，例如：

```ts
desired = "preview-ready"
```

系统通过类似 Kubernetes controller 的方式不断调和：

```txt
observe → act → observe → act
```

Lease 负责选出当前唯一的调和器。  
CAS 负责防止旧 snapshot 覆盖新状态。

详见：[沙盒生命周期设计](./docs/runtime-lifecycle.md)

### 3. 实时状态投影，而不是前端轮询

Preview、Agent Run、Browser Test 的状态变化频繁。

BabyLovable 不让前端不断轮询多个接口拼状态，而是在服务端维护一份统一的 `SessionRuntimeProjection`。

后端状态变化后，将运行态投影成前端需要的读模型，再通过 Supabase Realtime 推送整行更新。

前端进入页面时拉取一次初始状态，之后只接收 Realtime 更新，并用单调 `version` 拒绝旧包。

这样可以减少轮询压力，也能避免多 tab 和刷新后的状态分叉。

详见：[实时状态同步设计](./docs/realtime-projection.md)

### 4. Agent 自动浏览器验收

Agent 不只负责写代码，也可以打开浏览器检查结果。

BabyLovable 集成 Cloudflare Browser Rendering，让 Agent 能够访问 Preview 页面，观察页面渲染结果，并根据测试反馈继续修改代码。

这让 Agent 的闭环从：

```txt
生成代码
```

变成：

```txt
生成代码 → 启动预览 → 浏览器检查 → 根据结果继续修复
```

## 架构概览

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

运行态同步链路：

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

资源调和负责让远程沙盒稳定收敛。  
实时投影负责让前端及时、一致地看到状态变化。

这两件事拆开，是为了避免用轮询、进程内状态或单次请求生命周期硬扛 Serverless 并发。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| App | Next.js 16 |
| Agent | Vercel AI SDK v7 `WorkflowAgent` |
| Workflow | Vercel Workflow / Serverless Workflow |
| Sandbox | Daytona Sandbox + 自建镜像 |
| Auth | Supabase Auth |
| Realtime | Supabase Realtime |
| Database | Supabase Postgres |
| Browser Test | Cloudflare Browser Rendering |
| UI Sync | SessionRuntimeProjection + Realtime |

## 本地开发

- 支持本地文件存储，方便无 DB 启动
- 支持本地沙盒模拟，不强依赖 Daytona
- 支持 Supabase Auth / Realtime 接入
- 支持 All-in-one 本地调试与 CLI 端到端验证

详见：[本地开发指南](./docs/local-development.md)

## 文档

- [沙盒生命周期设计](./docs/runtime-lifecycle.md)
- [实时状态同步设计](./docs/realtime-projection.md)
- [Workflow Agent 设计](./docs/workflow-agent.md)
- [本地开发指南](./docs/local-development.md)

## Roadmap

- [ ] Agent Runtime 治理：长上下文治理、工具结果压缩等
- [ ] 代码产物持久化：云端版本控制，接入 Freestyle Git 和 GitHub 双向同步
- [ ] 产品体验优化：UI / UX 优化
- [ ] 第三方连接器：Supabase BaaS、Vercel Deploy、图片素材生成 MCP 工具等
