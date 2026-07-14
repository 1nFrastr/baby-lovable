# 完成度与路线图

> 对应面试要求：做了什么、没做什么、继续投入的优先级。总览见 [../README.md](../README.md)。

## 1. 功能完成度矩阵

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 自然语言驱动改 Next 应用 | ✅ | Builder Agent + starter template |
| 文件工具（读写改删搜） | ✅ | 源码路径守卫 |
| 依赖安装（白名单） | ✅ | pnpm add/remove/install |
| 托管 Preview + checkPreview | ✅ | local + daytona |
| CLI one-shot / REPL / resume | ✅ | 与 Web 同 Agent |
| Web 流式聊天 + 续流 + draft | ✅ | Workflow DevKit |
| 多会话 UI / URL | ✅ | `/sessions/[id]` |
| Local 零后端模式 | ✅ | 文件存储 + 跳过登录 |
| Supabase Auth + Postgres | ✅ | 生产路径 |
| Daytona 远程沙盒 | ✅ | Volume + Snapshot + Preview |
| Signed Preview iframe | ✅ | Web |
| Cloudflare Browser Run / testPreview | ✅ | 需 Daytona + CF；opt-in |
| Auto Test + Live View PiP | ✅ | |
| 每 turn git checkpoint | ✅ | lastCommitSha |
| Daytona workspace export | ✅ | zip 路径 |
| Local workspace export | ❌ | `NotImplementedError` |
| Web UI 选择 sandbox | ❌ | 仅环境变量 |
| git remote push | ❌ | 字段预留 |
| 任意 shell | ❌（有意） | runCommand deprecated |
| Local 上 Browser Run | ❌（有意） | 架构不可达 |
| 协作编辑 / 权限角色 | ❌ | |
| 计费与配额产品化 | 🟡 | 有错误提示，无完整产品 |
| 消息历史裁剪 / 摘要 | ❌ | 长会话成本未治理 |
| 自动回归测试套件（host） | 🟡 | 靠 CLI 脚本与专项 test:*，无完整 CI 矩阵 |

图例：✅ 可用 · 🟡 部分 · ❌ 未做 / 有意不做

---

## 2. 工程质量快照

| 维度 | 现状 | 缺口 |
| --- | --- | --- |
| 可运行性 | 本地一条命令可演示 | 生产需配齐 Supabase / Daytona / CF |
| 可观测性 | CLI trace + `[agent-trace]` + session.json | 无统一 APM |
| 安全 | 路径与命令白名单、RLS（Supabase） | Local 模式无用户隔离 |
| 稳定性 | 大量 Daytona/Vercel isolate 修复已合入 | 冷启动 / 配额仍属运维现实 |
| 文档 | 本目录 + AGENTS.md + README | 可再补演示录屏与架构海报 |

---

## 3. 若继续投入：建议优先级

### P0 — 默认路径更稳（完成度 / 可交付）

1. Agent 结束前强制或强提示 `checkPreview`（减少 incomplete WARN）
2. Daytona Preview 在多 isolate 下的状态一致性（已有 adopt，继续收敛边界情况）
3. 配额 / 密钥缺失时的 UX 文案统一（Daytona、CF、AI Gateway）

### P1 — 交付闭环（可交付性 / UX）

1. Local workspace zip 导出（与 Daytona 对称）
2. `gitRemote`：可选推到用户仓库（面试故事完整：「对话在 DB，代码在 GitHub」）
3. 分享链接：只读 Preview / 只读会话

### P2 — 体验清晰（UX）

1. Web 明示当前 sandbox（local vs daytona）与能力差异（能否 Auto Test）
2. 可选：设置页切换 sandbox（需处理会话已绑定模式的迁移规则）
3. 首轮引导：示例 prompt +「发生了什么」时间线

### P3 — 加深创新（创新性）

1. App Test 断言 DSL / 脚本库（不止 todo heuristic）
2. 失败步骤 → 自动开一轮修复 turn（有限次）
3. 视觉回归（截图 diff）——注意成本

### P4 — 平台化（后置）

1. 多模型路由、人机审批（WorkflowAgent `needsApproval`）
2. 组织 / 团队空间
3. 自建队列多云——仅当离开 Vercel Workflow 有强需求时

---

## 4. 明确「不做」清单（控制复杂度）

短期不打算做：

- 在 Agent 内开放任意 bash
- 把源码 blob 存进 Postgres
- Local Preview 强行对接 Cloudflare Browser Run
- 为面试 Demo 同时维护 E2B + Daytona 两套远程后端

---

## 5. 建议的演示脚本（评审 5–10 分钟）

1. **Local CLI**（工程思维）：`npm run agent -- -p "…"` → 展示 `session.json` + workspace  
2. **Web Preview**（UX）：同会话或新会话，展示 iframe 热更新  
3. **（可选）Daytona + Auto Test**（创新）：远程 Preview + Live View  
4. **打开 README.md**（可交付性）：取舍与完成度自述  

---

## 6. 待细化大纲钩子

- [ ] 是否用百分比给「整体完成度」一个主观分（例如核心闭环 85%，云端增强 70%）？
- [ ] 是否列出已知 bug / 限制的 issue 风列表？
- [ ] 是否补充部署拓扑图（Vercel + Supabase + Daytona + CF）？
- [ ] 演示账号 / 环境是否单独 `docs/DEMO.md`（含密钥获取步骤，不含密钥本身）？
