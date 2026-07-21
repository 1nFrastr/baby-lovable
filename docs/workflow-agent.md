# Workflow Agent 设计

用 Vercel AI SDK v7 `WorkflowAgent` + Serverless Workflow，在 Serverless 上承载可恢复的长任务 Agent。

## 要解决的问题

普通 HTTP 请求生命周期不适合：

- 多步工具调用（读写文件、装依赖、检查 Preview、浏览器验收）
- 页面刷新 / 断线后继续看输出
- 步骤失败后重试，而不是整轮重来

## 设计选择

BabyLovable 使用 `WorkflowAgent` 把一轮对话拆成可观测、可恢复、可重试的步骤：

- **持久执行**：步骤状态落在 Workflow 运行时，不依赖单次 isolate 存活
- **可恢复流**：Web UI 通过 Workflow 传输恢复会话流；刷新后仍能接上输出
- **工具隔离**：沙盒文件 CRUD、Preview 探测、Browser Test 等作为 tool / step，与编排层解耦

Host 层（`src/workflow/`、`src/tools/`）负责 Agent 编排与工具；每个会话的生成应用落在独立 workspace / Daytona sandbox 中。

## 验证闭环

Agent 不只写代码，还通过工具形成闭环：

```txt
编辑源码 → checkPreview →（可选）Browser Test → 根据反馈继续修复
```

Preview 生命周期由沙盒调度层（见 [runtime-lifecycle.md](./runtime-lifecycle.md)）负责；Agent 声明「需要 preview-ready」，不直接命令式起停沙盒。

## 相关入口

| 路径 | 作用 |
| --- | --- |
| `src/workflow/builder-agent.ts` | 共享 WorkflowAgent + system prompt |
| `src/workflow/builder-chat.ts` | Web 持久 workflow（`'use workflow'`） |
| `src/tools/builder-tools.ts` | 构建工具面 |
| `src/cli/` | 与 Web 同 Agent 的 headless 跑法，便于端到端验证 |

本地 CLI 与 Web 共用同一套 Agent / 工具 / 系统提示，方便无浏览器回归。详见 [local-development.md](./local-development.md)。
