# baby-lovable

**baby-lovable** 是对标 [Lovable](https://lovable.dev) 的 baby 版本

演示地址：https://baby-lovable.vercel.app/

演示 1：基础能力

https://github.com/user-attachments/assets/df081939-f3ec-44fb-ba3f-13a68d9ce010

演示 2：可恢复流 resumable streaming

https://github.com/user-attachments/assets/2eca82e8-ebeb-4bcb-b359-abd4bcb76b98

演示 3：自动化浏览器测试 AutoTest

https://github.com/user-attachments/assets/3d307aae-430f-4a4d-8659-d11ce6f7f050

演示 4：持久化工作流引擎与可观测性 Durable Workflow

https://github.com/user-attachments/assets/1a0d6756-facb-4094-a883-4422a742bee9


### 亮点技术栈

- **Agent**：Vercel AI SDK v7 `WorkflowAgent` + Workflow DevKit（durable 多步、流式续传）
- **沙盒**：Daytona 远程 workspace（Volume 持久化 / Snapshot 冷启动 / signed Preview）
- **自动测**：Cloudflare Browser Run + Playwright Live View（对云端 Preview 可见地点测）
- **宿主**：Next.js 16 · Supabase Auth/Postgres（多用户）· 本地文件模式可零后端开发 · 同款 CLI 自回归

---

## 1. 实现思路

### 1.1 先跑通闭环，再逐层加生产能力

开发不是一次性堆完整后端，而是按「可验证增量」推进（详见 [docs/ENGINEERING.md](./docs/ENGINEERING.md)）：

| 阶段 | 目标 | 关键产出 |
| --- | --- | --- |
| P0 | Agent 能改代码 | Local sandbox + file tools + session.json |
| P1 | 可自验证 | CLI one-shot + 托管 `pnpm dev` + `checkPreview` |
| P2 | 可续聊 / 可恢复 | Session resume、draft、runStatus |
| P3 | 可多人 / 可部署 | Supabase Auth + Postgres（本地模式仍可关掉） |
| P4 | 可隔离执行 | Daytona sandbox + Volume + signed Preview |
| P5 | 可测 UI | Cloudflare Browser Run + `testPreview` / Auto Test |

每一阶段都保持：**同一套 Agent / tools / prompt**，只替换存储与执行后端。

### 1.2 三条工程原则（贯穿始终）

1. **接口先行**：`ProjectSandbox`（fs / process / git）让 local 与 Daytona 共用工具面。
2. **文件优先**：开发默认无登录、无数据库；`.baby-lovable/` 即真相源。
3. **CLI 先行**：`npm run agent -- -p "…"` 与 Web 共用 Agent，方便 Cursor 编码 Agent 做端到端自回归。

### 1.3 核心产品闭环

```
编辑源码 → 小改靠 HMR；首轮/大改/compileError 时 checkPreview
        → testPreview（UI 冒烟，显式 / Auto Test，仅 Daytona）
        → 会话落库（或 session.json）+ workspace git checkpoint
```

---

## 2. 关键取舍（摘要）

完整论述见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

| 决策 | 选择 | 不选 / 推迟 | 一句话理由 |
| --- | --- | --- | --- |
| Agent 运行时 | Vercel AI SDK v7 **WorkflowAgent** + Workflow DevKit | 自建 Redis/Bull 队列 + 手写状态机 | 流式续传、step 重试、与 Vercel 一体；长 turn 天然 durable |
| 远程沙盒 | **Daytona** | E2B 等 | 一套 SDK 覆盖 fs/process/git/preview/volume/snapshot；公开 Preview URL 可被 Browser Run 访问 |
| UI 测试 | **Cloudflare Browser Run** + Playwright | 本地 Playwright / 仅靠编译 | localhost 对云端浏览器不可达；远程 Preview + Live View 才构成「可见」的自动测 |
| 会话存储 | Local 文件 **或** Supabase | 一开始就绑定 DB | 开发零摩擦；生产用同一门面切换 |
| 代码版本 | Workspace + **每 turn git commit**（+ Daytona Volume） | 把源码塞进 DB | 对话与代码分真相源；便于 diff / 导出 / 恢复 |
| 验证策略 | `checkPreview` 按需（首轮/大改/compileError）；`testPreview` opt-in | Agent 每步都跑浏览器 | 控制成本与延迟；编译错误覆盖大多数失败 |

---

## 3. 当前完成程度（用户视角）

### 已完成

- **对话式建站**：用自然语言描述需求，Agent 在隔离工作区里生成 / 修改 Next.js 应用
- **实时预览**：右侧预览生成中的应用；编译失败会反馈给 Agent 继续修
- **多项目会话**：侧边栏新建 / 切换项目；每个会话有独立 URL，可稍后回来接着改
- **流式对话与刷新恢复**：回复边生成边显示；中途刷新可续上未完成的一轮
- **账号与多用户隔离**（生产部署）：GitHub 授权登录（开发环境另有匿名登录）；用户只能看到自己的会话与数据
- **云端隔离运行**（可选）：项目在远程沙盒中构建与预览，关闭后源码仍可恢复
- **一键导出代码**（云端模式）：预览面板可下载 workspace zip
- **自动 UI 测试**（云端模式 + 已配置浏览器服务）：「Auto Test」用远程浏览器点一遍页面，并可弹出 Live View 观看测试过程
- **命令行同款能力**：CLI 可无界面跑同一套建站 Agent，方便自动化验收

### 未做 / 部分完成

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| **长上下文管理** | 未做 | 多轮对话 + 工具结果会把上下文撑满；尚无摘要 / 裁剪 / 压缩，长项目易变慢、变贵、跑偏 |
| **工具治理** | 部分 | 已有路径与命令白名单、部分工具输出对 UI 隐藏；缺统一的结果截断、调用预算、失败退避与「何时必须 / 禁止用某工具」策略 |
| **对话消息 UI** | 部分 | 能流式看回复与工具调用；长会话下工具块嘈杂、层次弱，缺折叠 / 摘要时间线 / 更清晰的「正在改什么」 |
| 界面里切换「本机预览 / 云端沙盒」 | 未做 | 由部署环境变量决定 |
| 本机模式下导出 zip | 未做 | 仅云端模式支持 Export |
| 把项目推送到用户自己的 GitHub 仓库 | 未做 | 有预留，未接通 |
| 分享只读链接（项目 / 预览）给他人 | 未做 | |
| 本机预览上跑 Auto Test | 不做 | 远程浏览器访问不到 localhost |
| 多人同时编辑同一项目 | 未做 | 当前是单用户会话 |
| 套餐 / 计费 / 自助升配额 | 部分 | 配额不足会提示，无完整付费产品 |

更细矩阵见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

---

## 4. 若继续投入：扩展与优先级

| 优先级 | 方向 | 为什么先做 |
| --- | --- | --- |
| **P0** | **长上下文管理**：历史摘要、工具结果压缩、按需回捞文件而非整段塞进 prompt | 多轮建站是核心场景；上下文失控会直接毁掉可用性与成本 |
| **P0** | **工具治理**：输出截断与预算、调用频率约束、强制编译门控与测试 opt-in 策略固化 | 减少无效 tool loop、漏验预览、噪声结果污染下一轮推理 |
| **P0** | **对话消息 UI**：工具调用折叠 / 分组、进度时间线、突出文件路径与验证结果 | 用户要看得懂 Agent 在干什么，而不是被 tool 日志淹没 |
| P1 | 预览更稳、缺配额 / 密钥时的产品级提示 | 「能不能用」的底线体验 |
| P2 | 本机导出、推 GitHub、分享只读预览 | 做完能带走 / 能给别人看 |
| P3 | 界面可选本机或云端；更强 Auto Test（失败后再修） | UX 与创新加深 |
| P4 | 团队空间、多模型、人机审批长任务 | 平台化，后置 |

原则：**先治住上下文、工具行为与对话可读性，再堆交付与协作能力**——否则会话越长越不可用、也越难看懂。

---

## 5. 如何验证（给评审）

```bash
cp .env.example .env.local
# 至少配置 AI_GATEWAY_API_KEY（或 OPENAI_API_KEY）

npm install

# 1) 本地零后端
BABY_LOVABLE_LOCAL_MODE=1 npm run agent -- -p "创建一个简单的计数器页面"

# 2) 看产物
ls .baby-lovable/sessions/
# 打开对应 session.json / workspace/src

# 3)（可选）Web
BABY_LOVABLE_LOCAL_MODE=1 NEXT_PUBLIC_BABY_LOVABLE_LOCAL_MODE=1 npm run dev
```

生产 / Daytona / Browser Run 路径见 [`.env.example`](./.env.example) 与 [AGENTS.md](./AGENTS.md)。

---

## 6. 开发用量（Cursor）

本仓库从脚手架到当前形态，主要在 Cursor 里用 Agent 推进。以下为 **本项目相关** 的 IDE 用量（已剔除无关会话），区间 `2026-07-12 15:36` → `2026-07-14 08:22`（+08），原始明细见 [docs/usage/usage-events-2026-07-14.csv](./docs/usage/usage-events-2026-07-14.csv)。

| | |
| --- | ---: |
| **总 Token** | **221,116,210**（约 2.21 亿） |
| 事件数 | 667 |

分项：Cache Read 204.2M · Input 15.0M · Output 1.9M。

| 模型 | 事件 | Total Tokens | 占比 |
| --- | ---: | ---: | ---: |
| composer-2.5-fast | 284 | 102,087,741 | 46.2% |
| cursor-grok-4.5-high-fast | 167 | 60,890,744 | 27.5% |
| auto | 173 | 50,919,901 | 23.0% |
| 其他（grok-4.5-xhigh / sonnet / gpt-5.6） | 43 | 7,217,824 | 3.3% |
| **合计** | **667** | **221,116,210** | **100%** |

按日：7/12 18.6M · 7/13 146.0M · 7/14 56.5M。

---

## 7. 文档地图

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [docs/ENGINEERING.md](./docs/ENGINEERING.md) | 关注工程思维 | 阶段划分、文件优先、CLI 自回归 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 关注选型 | WorkflowAgent / Daytona / Browser Run |
| [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) | 关注数据 | 会话 vs 代码真相源、状态机 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 关注完成度 | Done / Not done / Next |
| [docs/usage/usage-events-2026-07-14.csv](./docs/usage/usage-events-2026-07-14.csv) | 关注用量 | 本仓库 Cursor Token 明细 |
| [AGENTS.md](./AGENTS.md) | 跑 Agent | 操作手册 |
