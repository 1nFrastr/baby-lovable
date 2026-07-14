# 工程方法：渐进迭代 · 文件优先 · CLI 先行

> 软件工程层面的设计经验。产品级取舍见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 1. 为什么要「渐进式」而不是一次做完

目标产品形态接近 Lovable / v0：聊天 → 改代码 → 预览 →（可选）自动测。若一开始就绑定 Auth、DB、远程沙盒、浏览器农场，调试面过大，且编码 Agent 难以在本地自回归。

策略：**每一阶段都产出一条可演示、可断言的垂直切片**，上层业务（tools / prompt / UI）尽量不动，只替换基础设施。

---

## 2. 开发阶段划分（与 git 历史对齐）

下列阶段对应仓库真实演进（2026-07-12 → 07-14），不是事后美化。

### Phase 0 — Host 脚手架

- Create Next App + Workflow DevKit 接线
- 目标：能部署一个 Next 宿主

### Phase 1 — Agent Runtime（P0 闭环）

代表提交：`feat: baby-lovable core agent runtime`

- `WorkflowAgent` + builder tools（读写文件）
- `ProjectSandbox` 抽象 + **Local** 实现
- per-session `workspace/` + `session.json`
- Web chat 流式

**验收**：用户一句话，Agent 能改 workspace 里的源码。

### Phase 2 — Template + CLI（可自回归）

代表提交：starter template、`feat: add CLI mode with console tracing`

- 新会话从 `templates/nextjs-starter` 种子化
- `npm run agent`：one-shot / REPL / `-s` resume
- 结构化 trace：`STEP` / `TOOL` / `DONE`

**验收**：Cursor / 编码 Agent 可不打开浏览器，用 CLI 断言行为。

### Phase 3 — Preview 门控（可验证）

代表提交：auto-bootstrap preview、`checkPreview`、路径守卫、orphan cleanup

- 平台托管 `pnpm install` + `pnpm dev`（Agent **禁止**自己起 dev server）
- `checkPreview`：编译 / HTTP / buildError
- 限制 shell（白名单 pnpm）；禁止写 `.next` / `node_modules`

**验收**：坏代码会被 `buildError` 拦住；修好后 `ok: true`。

### Phase 4 — 会话连续性（可用）

代表提交：session resume、draft.json、auto-continue

- URL `/sessions/[id]`、多会话侧边栏
- 流式中 `draft`；刷新后续流
- 输出 token 触顶时的 invisible auto-continue

**验收**：刷新不丢回复；长回复可续。

### Phase 5 — 生产存储（可部署），但保留逃生舱

代表提交：Supabase auth + Postgres；随后 `local file mode override`

- `store.ts` 门面 → `store-local` | `store-supabase`
- Auth middleware；CLI 可用 `BABY_LOVABLE_DEV_USER_ID`
- **`BABY_LOVABLE_LOCAL_MODE=1`**：即使有 Supabase env 也退回文件模式

**验收**：Vercel + 登录可用；本地 / CI 仍可零后端。

### Phase 6 — Daytona（可隔离）

代表提交：Daytona sandbox、snapshot、Web iframe、volume sync

- 同一 `ProjectSandbox` 换后端
- Volume：计算盘 ephemeral，持久盘只存源码
- Snapshot 预装依赖，缩短冷启动
- Signed Preview URL 供 iframe

**验收**：云端隔离跑 Next；预览可嵌。

### Phase 7 — Browser Run（可测 UI）

代表提交：Cloudflare Browser Run app testing；Auto Test opt-in

- `testPreview` tool + Live View PiP
- 仅 Daytona（localhost 对 CF 不可达）
- 状态走 durable store（适配 Vercel 多 isolate）

**验收**：对远程 Preview 跑 Playwright；UI 可看 Live View。

---

## 3. 本地无后端依赖 · 文件优先

### 3.1 设计目标

让「写代码的人」和「写代码的 Agent」在笔记本上都能：

- 不申请云账号也能跑通主路径
- 不启动 Postgres / Redis
- 不登录
- 用读文件代替猜状态

### 3.2 机制

```
isLocalFileStorageMode()
  ← BABY_LOVABLE_LOCAL_MODE=1
  ← 或未配置 Supabase URL/key
```

数据根：`.baby-lovable/`（可用 `BABY_LOVABLE_DATA_DIR` 覆盖）

```
.baby-lovable/sessions/<sess_id>/
  session.json           # 对话 + 元数据
  draft.json             # 流式草稿（Web）
  app-test-status.json   # App Test 状态
  workspace/             # 生成的 Next 应用
```

### 3.3 与生产模式的关系

| | Local file | Supabase |
| --- | --- | --- |
| Auth | 跳过（`userId: null`） | Cookie JWT |
| 会话 | `session.json` | `sessions` 表 + RLS |
| Draft | `draft.json` | `session_drafts` |
| App Test 状态 | `app-test-status.json` | `session_app_test_status` |
| 业务 API | **同一套** `createSession` / `replaceMessages` / … | 同左 |

**取舍**：本地模式弱化多用户隔离，换取迭代速度；生产路径用同一抽象升级，避免「开发版 / 生产版两套产品」。

---

## 4. CLI 先行 · 编码 Agent 自回归

### 4.1 问题

Web UI 对人类友好，但对自动化不友好：要开浏览器、看 iframe、点按钮。面试项目的「工程质量」很大程度取决于：**改完 host 代码后，能否快速证明 Builder 仍工作**。

### 4.2 做法

- CLI 与 Web **共用** `createBuilderAgent(sessionId, sandboxMode)`
- CLI **刻意不走** durable workflow（直接 `agent.stream()`），降低调试噪声；`'use step'` 在编译器外退化为普通 async
- One-shot（`-p`）结束即退出，适合脚本 / Cursor Agent
- Trace 落终端 + `session.json`；workspace 源码可直接 `read` / `diff`

### 4.3 推荐自回归循环（编码 Agent）

```bash
npm run agent -- -p "<代表性用户需求>"
# 读 .baby-lovable/sessions/<id>/session.json 里最后一次 checkPreview
# 读 workspace/src 断言行为
# 修 host 或 prompt 后：npm run agent -- -s <id> -p "修一下…"
```

Web 仅作人眼视觉抽检，**不作为默认验收门**。

### 4.4 附带收益

- 同一套 tools 在 headless 下暴露漏洞更快（路径逃逸、无限 shell、忘记 checkPreview）
- AGENTS.md 把「如何验」写进仓库，后人 / 模型可复用

---

## 5. 复杂度控制清单（实践中坚持的）

1. **Agent 不拥有基础设施**：不让模型 `rm -rf .next`、不让模型自己 `pnpm dev`。
2. **工具面窄而深**：文件 CRUD + 白名单包管理 + 两个验证工具，优于开放 shell。
3. **默认便宜、增强显式**：编译检查默认；浏览器测试 opt-in。
4. **状态可 grep**：文件模式下，出问题先 `cat session.json`，再谈可观测性平台。
5. **抽象边界清晰**：`ProjectSandbox` / session store facade / preview lifecycle 三处可替换，其余尽量不复制。

---

## 6. 待你我一起细化的大纲钩子

- [ ] 每个 Phase 是否补「失败案例 / 回滚方式」一小节？
- [ ] 是否加入「时间盒」叙事（例如总投入约 N 天、每日目标）？
- [ ] CLI 与 Web 行为差异表是否需要完整对照（draft / resume / cleanup）？
- [ ] 是否单独写一页「给 Cursor Agent 的验收 checklist」？
