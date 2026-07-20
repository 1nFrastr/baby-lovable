# baby-lovable

**baby-lovable** 是一款基于 Serverless 架构的多用户云端 Coding Agent

演示地址：https://baby-lovable.vercel.app/

| 基础能力 | 可恢复流 |
| --- | --- |
| https://github.com/user-attachments/assets/df081939-f3ec-44fb-ba3f-13a68d9ce010 | https://github.com/user-attachments/assets/2eca82e8-ebeb-4bcb-b359-abd4bcb76b98 |
| **自动化浏览器测试** | **持久工作流** |
| https://github.com/user-attachments/assets/3d307aae-430f-4a4d-8659-d11ce6f7f050 | https://github.com/user-attachments/assets/1a0d6756-facb-4094-a883-4422a742bee9 |

### 核心能力

| | |
| --- | --- |
| **Agent 编排** | Vercel AI SDK v7 `WorkflowAgent` |
| **持久执行** | Workflow Serverless：挂了能续、失败重试、可观测性 |
| **可恢复流** | 刷新不断流，会话历史落库可回看 |
| **隔离沙盒** | Daytona Sandbox + 自建镜像 |
| **资源调和** | Lease + CAS，像 K8s 一样 observe → act，把 Serverless 下的沙盒并发串行管住 |
| **实时同步** | Supabase Realtime 推送会话与 Preview 状态，前端不用轮询 |
| **多用户隔离** | Supabase Auth + RLS，认证授权和数据权限隔离 |
| **自动 E2E** | Cloudflare BrowserRun，Agent 自己开浏览器验结果 |

## 1. 实现思路

### 1.2 三条工程原则

1. **接口先行**：`ProjectSandbox`（fs / process）让 local 与 Daytona 共用工具面。
2. **文件优先**：开发默认无登录、无数据库；`.baby-lovable/` 即真相源。
3. **CLI 先行**：`npm run agent -- -p "…"` 与 Web 共用 Agent，方便 Cursor 编码 Agent 做端到端自回归。

开发体验优先，

## 4. 若继续投入：扩展与优先级

Agent Runtime 治理：长上下文治理、工具结果压缩等
代码产物持久化：云端版本控制，接入 Freestyle Git和 Github 双向同步
产品体验优化：UI/UX等优化


## 7. 文档地图

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [docs/ENGINEERING.md](./docs/ENGINEERING.md) | 关注工程思维 | 阶段划分、文件优先、CLI 自回归 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 关注选型 | WorkflowAgent / Daytona / Browser Run |
| [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) | 关注数据 | 会话 vs 代码真相源、状态机 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 关注完成度 | Done / Not done / Next |
| [docs/usage/usage-events-2026-07-14.csv](./docs/usage/usage-events-2026-07-14.csv) | 关注用量 | 本仓库 Cursor Token 明细 |
| [AGENTS.md](./AGENTS.md) | 跑 Agent | 操作手册 |
