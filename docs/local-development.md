# 本地开发指南

支持无 DB、本地沙盒模拟，以及接 Supabase / Daytona 的云端配置。

## 原则

| 原则 | 要点 |
| --- | --- |
| **可观测性驱动** | CLI Agent 不依赖 Web UI；本地沙盒不依赖远程 Daytona；文件持久化可不依赖 DB |
| **开发体验优先** | 本地模拟或 Daytona；本地文件免登录，或接 Supabase Auth |
| **All-in-one** | 仓库内即可启动与 Debug，方便 Agent / 人工端到端自回归 |

## 快速开始

```bash
# 依赖
pnpm install   # 或 npm install

# 配置环境变量（按仓库内示例复制并填写）
# AI_GATEWAY_API_KEY 或 VERCEL_OIDC_TOKEN
# 可选：Supabase / Daytona / Cloudflare Browser 相关变量

# Host 应用
npm run dev
```

默认会话数据目录：`.baby-lovable/`（可用 `BABY_LOVABLE_DATA_DIR` 覆盖）。

## CLI（推荐用于验证）

与 Web 同一套 builder agent、工具和 system prompt：

```bash
npm run agent -- -h                          # help
npm run agent -- -l                          # list sessions
npm run agent -- -p "创建一个待办事项应用"    # one-shot
npm run agent -- -s sess_abc123 -p "加渐变色" # resume + one-shot
npm run agent                                # interactive REPL
```

常用 flag：`-p` 单轮退出、`-s` 复用会话、`--sandbox local|daytona`、`--max-steps`。

## 本地 vs 云端

| 能力 | 本地 | 云端 |
| --- | --- | --- |
| 会话存储 | 文件（`.baby-lovable/`） | Supabase Postgres |
| 鉴权 | 可免登录 | Supabase Auth + RLS |
| 沙盒 | 本地 workspace + 本机 preview | Daytona Sandbox |
| 运行态推送 | Host SSE | Supabase Realtime |

## 清理孤儿 Preview

会话 preview 可能以 detached 进程残留。清理（不停 host `npm run dev`）：

```bash
npm run cleanup-previews
npm run cleanup-previews -- --dry-run
npm run cleanup-previews -- --keep sess_abc123
```

## 验证产物

不依赖浏览器时，可读：

- `.baby-lovable/sessions/<id>/session.json` — 消息与工具调用
- `.baby-lovable/sessions/<id>/agent.log` — CLI 追踪
- `.baby-lovable/sessions/<id>/workspace/` — 生成源码
- 最后一次 `checkPreview` 是否 `ok: true`

Host 代码变更后建议在仓库根目录跑 `npm run lint` 与 `npm run build`。
