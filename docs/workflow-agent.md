# Workflow Agent 设计

BabyLovable 使用 Vercel AI SDK v7 `WorkflowAgent` 和 Serverless Workflow，在 Serverless 环境中承载可恢复的长任务 Agent。

一句话概括：

> Agent 的执行过程不绑定单次 HTTP 请求，而是拆成可持久化、可恢复、可重试的工作流步骤。

## 要解决的问题

Coding Agent 一轮对话通常不是一次模型调用就能结束。它可能需要连续执行很多步骤：

- 理解用户需求
- 读取项目文件
- 修改源码
- 安装依赖
- 启动或检查 Preview
- 打开浏览器验收结果
- 根据错误继续修复
- 把最终状态同步给前端

这些操作耗时长，而且中间可能失败。如果把整轮任务都放在一个普通 HTTP 请求里，会遇到几个问题。

**第一，请求生命周期太短。** Serverless 请求不适合长期占用。一轮 Agent 任务可能持续几十秒甚至更久，不能依赖单次请求一直存活。

**第二，页面连接不可靠。** 用户可能刷新页面、切换 tab，或者网络中断。如果输出流只绑定当前连接，断开后就很难恢复。

**第三，失败恢复成本高。** 如果某个工具调用失败（依赖安装、Preview 检查、浏览器测试），系统应该从失败步骤附近重试，而不是把整轮对话从头再跑一遍。

所以这里需要的不是一个普通的 chat API，而是一套可恢复的 Agent Workflow。

## 核心设计

BabyLovable 用 `WorkflowAgent` 来编排一轮 Agent 对话。一轮对话会被拆成多个可观测的步骤，每个步骤的执行状态由 Workflow 运行时保存，而不是只存在当前 isolate 的内存里。

这样做的好处是：

- Agent 执行不依赖单次 HTTP 请求生命周期
- 页面刷新后仍然可以恢复输出
- 步骤失败后可以按 Workflow 语义重试
- 工具调用过程可以被观察和调试
- Web 和 CLI 可以复用同一套 Agent 能力

## 持久执行

在普通 Serverless 模型里，一个请求结束后，当前 isolate 里的内存状态就不可靠了。但 Agent 任务需要跨越多个异步步骤。

BabyLovable 把 Agent 的执行过程放进 Serverless Workflow 中。Workflow 运行时负责记录步骤状态、执行进度和失败信息。

这意味着：

> Agent 的进度属于 Workflow，不属于某个正在运行的 HTTP 请求。

即使某次连接断开，或者某个 isolate 不再存活，后续请求仍然可以根据持久化的 Workflow 状态恢复执行或继续观察结果。

## 可恢复流

用户在 Web UI 中看到的是 Agent 输出流，但这个流不能只依赖当前浏览器连接。如果用户刷新页面，系统需要做到：

> 新页面能够重新接上当前会话的输出和状态。

BabyLovable 通过 Workflow 传输恢复会话流。前端重新进入会话时，可以根据已有的 Workflow 状态和消息历史恢复展示，而不是重新发起一轮 Agent 执行。这让用户体验更接近一个持续运行的任务，而不是一次脆弱的 HTTP streaming。

## 工具隔离

Agent 编排层不直接关心具体工具怎么实现。BabyLovable 将工具能力拆出来，作为独立的 tool / step 暴露给 Agent。典型工具包括：

- 文件读取 / 写入
- 目录查看
- 依赖安装
- Preview 检查
- Browser Test
- 沙盒相关操作

编排层负责决定什么时候调用工具，工具层负责执行具体副作用。这样可以让 Agent 的系统提示、工具定义、沙盒实现和 UI 同步各自演进，不互相耦合。

## 和声明式资源调和的关系

Agent 需要 Preview，但它不应该直接命令式地创建 sandbox 或启动 dev server。也就是说，Agent 不应该这样做：

```txt
createSandbox
startDevServer
createPreviewURL
```

它应该只声明自己需要的目标状态：

```txt
preview-ready
```

Preview 生命周期由沙盒调度层负责。沙盒调度层会根据当前状态决定是否需要创建 sandbox、启动 dev server、刷新 PreviewURL，直到目标状态满足。

所以 Agent 和沙盒之间的关系是：

```txt
Agent 声明需要 preview-ready
  → Runtime 调度层负责收敛
  → Agent 拿到可用 Preview 后继续执行
```

这样可以避免多个 Agent 工具调用、后台 warm、用户 Restart 同时操作沙盒时产生重复创建和状态覆盖。

详见：[声明式资源调和设计](./declarative-reconciliation.md)

## 验证闭环

BabyLovable 里的 Agent 不只是写代码。它可以通过工具形成一个完整反馈闭环：

```txt
编辑源码
  → checkPreview
  → Browser Test
  → 根据反馈继续修复
```

比如，Agent 修改完页面后，可以先检查 Preview 是否可用。如果 Preview 启动失败，Agent 可以读取错误信息并修复代码；如果 Preview 可用，Agent 还可以打开浏览器访问页面，观察渲染结果，再根据测试反馈继续迭代。

这让 Agent 的工作方式从「生成代码」变成「生成代码 → 运行 → 检查 → 修复」。这是云端 Coding Agent 的关键闭环。

## Host 和 Workspace 的边界

BabyLovable 把系统分成两部分：

```txt
Host
  → Agent 编排
  → Workflow
  → Tools
  → 状态同步

Workspace / Sandbox
  → 用户项目
  → 源码文件
  → 依赖
  → dev server
  → Preview
```

Host 层代码主要位于：

```txt
src/workflow/
src/tools/
src/cli/
```

它负责 Agent 编排、工具定义、运行状态和对外接口。每个会话生成的应用运行在独立 workspace 或 Daytona sandbox 中。这样用户项目和 Host 系统隔离，多个会话之间也不会互相污染。

## Web 和 CLI 复用同一套 Agent

除了 Web UI，BabyLovable 还提供 headless CLI 跑法。CLI 和 Web 共用：

- 同一套 Agent
- 同一套工具
- 同一套 system prompt
- 同一套工作区逻辑

这样可以在不打开浏览器的情况下做端到端验证。很多 Agent 问题不一定来自 UI，而是来自工具、提示词、沙盒状态或工作流编排。CLI 跑法可以把 Web UI 从调试链路里拿掉，让问题更容易定位。

详见：[本地开发指南](./local-development.md)

## 相关入口

| 路径 | 作用 |
| --- | --- |
| `src/workflow/builder-agent.ts` | 共享 `WorkflowAgent` 和 system prompt |
| `src/workflow/builder-chat.ts` | Web 持久 workflow，包含 `'use workflow'` 入口 |
| `src/tools/builder-tools.ts` | Agent 工具面定义 |
| `src/cli/` | 与 Web 共用同一套 Agent 的 headless 跑法 |

## 总结

这套 Workflow Agent 设计的核心是：

> 用 Workflow 承载 Agent 长任务，用 Tools 隔离副作用，用可恢复流连接 Web UI。

具体来说：

- Agent 任务不依赖单次 HTTP 请求跑完
- Workflow 保存步骤状态、执行进度和失败信息
- 页面刷新后可以恢复会话输出
- 工具调用和 Agent 编排解耦
- Preview 由沙盒调度层声明式收敛
- Agent 可以通过 Preview 和 Browser Test 形成验证闭环
- CLI 和 Web 复用同一套 Agent，方便端到端回归

最终效果是：

> Agent 不只是一次聊天请求，而是一条可以持续执行、恢复、观察和验证的云端工作流。
