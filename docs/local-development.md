# 本地开发指南

本地 Host 与线上使用同一条执行链路：Daytona 运行工作区，Freestyle `main` 持久化源码。仓库不提供本机沙箱或本机 Preview 模拟。

## 快速开始

```bash
pnpm install
cp .env.example .env.local

# 必填：
# AI_GATEWAY_API_KEY（或 VERCEL_OIDC_TOKEN）
# DAYTONA_API_KEY
# FREESTYLE_API_KEY

npm run dev
```

Supabase 仍是可选项。未配置 Supabase 时，会话、运行态投影和 Freestyle 仓库绑定记录写入 `.baby-lovable/`；这只是元数据存储差异，Agent 工作区始终在 Daytona。

## CLI（推荐用于验证）

CLI 与 Web 使用相同的 Builder Agent、Daytona 调和器和 Freestyle checkpoint：

```bash
npm run agent -- -h
npm run agent -- -l
npm run agent -- -p "创建一个待办事项应用"
npm run agent -- -s sess_abc123 -p "加渐变色"
npm run agent
```

常用 flag：`-p` 单轮退出、`-s` 复用会话、`--max-steps`。沙箱不可选择；传入旧的 `--sandbox` 会直接报错。

## 本地与线上差异

| 能力 | 本地 Host | 线上 Host |
| --- | --- | --- |
| 会话元数据 | 文件或 Supabase | Supabase |
| 鉴权 | 文件模式可免登录 | Supabase Auth + RLS |
| Agent 工作区 | Daytona Sandbox | Daytona Sandbox |
| 源码真相源 | Freestyle `main` | Freestyle `main` |
| 运行态推送 | 文件模式 SSE 或 Realtime | Supabase Realtime |

## 验证

- `session.json` / CLI trace 用于检查工具调用与最终回复。
- `checkPreview` 的最后结果必须为 `ok: true`。
- 源码与版本以 Freestyle `main` 为准；Daytona 工作树是运行时投影。
- Host 代码变更后运行 `npm run lint`、`npm test` 与 `npm run build`。
