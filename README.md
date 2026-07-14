# baby-lovable

> 面试 / 技术评审主文档。细节设计见 `docs/`。

## 一句话

**baby-lovable** 是一个 AI 驱动的 Next.js 应用构建器：用户用自然语言描述需求，Builder Agent 在隔离的 per-session workspace 中改代码，并通过托管 dev-server 预览（以及可选的远程浏览器测试）自动验证，而不是依赖人工点 UI。

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
编辑源码 → checkPreview（编译门控，默认）
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
| 验证策略 | `checkPreview` 默认；`testPreview` opt-in | Agent 每步都跑浏览器 | 控制成本与延迟；编译错误覆盖大多数失败 |

---

## 3. 当前完成程度

### 已完成（可演示 / 可运行）

- Local 沙盒全链路：聊天 → 改代码 → 预览 → CLI / Web
- CLI one-shot 与交互 REPL（与 Web **同 Agent**）
- Durable Web chat：Workflow run、断线续流、draft 恢复
- Local file mode ↔ Supabase Auth/Postgres 双存储门面
- Daytona：远程 workspace、Volume 持久化、Snapshot 冷启动、signed Preview iframe
- `checkPreview` 编译门控；路径白名单（禁止改 `.next` / `node_modules`）
- Cloudflare Browser Run：`testPreview` / Auto Test / Live View PiP（需 Daytona + CF 配置）
- 每 turn workspace git checkpoint；orphan preview 清理脚本

### 未做 / 刻意推迟

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Web UI 切换 sandbox | 未做 | 仅环境变量 `BABY_LOVABLE_SANDBOX_MODE` |
| Local 导出 zip | 未做 | Daytona 侧已有 export；local 抛 `NotImplementedError` |
| `gitRemote` push | 预留字段 | Schema 有字段，无 remote push 实现 |
| Local 上 Browser Run | 架构不可行 | CF 无法访问 localhost |
| 任意 shell / `runCommand` | 收紧 | Deprecated，仅允许白名单 pnpm |
| 协作 / 多席实时编辑 | 未做 | 单用户会话模型 |
| 计费 / 配额产品化 | 部分 | Daytona 配额错误有 surfacing；无完整计费 |

更细列表见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

---

## 4. 若继续投入：扩展与优先级

| 优先级 | 方向 | 为什么先做 |
| --- | --- | --- |
| P0 | 稳定性：Daytona 冷 isolate Preview 状态、Agent 未调 `checkPreview` 的引导 | 直接影响「可用」与完成度评分 |
| P1 | 导出与交付：local zip、git remote push、一键分享 Preview | 可交付性 / 用户闭环 |
| P2 | Web 可选 sandbox + 更清晰的「本地开发 vs 云端隔离」引导 | UX |
| P3 | 更强的 App Test：脚本库、断言 DSL、失败自动回归 | 创新性加深 |
| P4 | 多模型 / 人机审批 / 更长任务编排 | 平台化，复杂度高，后置 |

原则：**先让默认路径更稳更短，再加新能力**——与早期渐进迭代一致。

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

## 6. 文档地图

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [docs/ENGINEERING.md](./docs/ENGINEERING.md) | 关注工程思维 | 阶段划分、文件优先、CLI 自回归 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 关注选型 | WorkflowAgent / Daytona / Browser Run |
| [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) | 关注数据 | 会话 vs 代码真相源、状态机 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 关注完成度 | Done / Not done / Next |
| [AGENTS.md](./AGENTS.md) | 跑 Agent | 操作手册 |
