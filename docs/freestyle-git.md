# Freestyle Git 真相源

Daytona 会话以 Freestyle 私有仓库的 `main` 为代码持久化真相源。Local 模式仍使用本机 workspace，不调用 Freestyle。

## 行为摘要

- 一个 session → 一个 Freestyle 私有仓库（`session_git_repositories`）
- Agent 只改 sandbox 文件，不获得 Git 工具；`.git` 受 `protected-paths` 保护
- 每轮结束（完成 / 失败）后平台自动 `status → add → commit → push`
- Git 操作只走 Daytona SDK `sandbox.git.*`，禁止 `process.executeCommand("git …")`
- 聊天输入框只看 `run` 状态；`sourceControl` 单独投影同步中/失败/冲突
- Web UI（Daytona）：预览栏状态芯片 + **History** 只读版本列表（`GET /api/sessions/:id/versions`）；暂不支持 revert
- **GitHub Sync（可选）**：预览栏一键「同步到 GitHub」— 授权平台 App → 服务端建私有空仓 → Freestyle `githubSync.enable`；Freestyle 负责双向镜像（不做 force-push）

## 关键路径

| 时机 | 行为 |
| --- | --- |
| 创建 Daytona session | 校验 `FREESTYLE_API_KEY`；启动 durable `provisionFreestyleRepoWorkflow`；reconciler 创建 VM 后 hydrate |
| 轮次结束 | 解锁 UI → 入队 sync task → 启动 durable `gitTurnCheckpointWorkflow`（不等待 push） |
| 下一轮写文件 | `awaitPreviousCheckpoint` 只等待；死 worker 时 CAS 踢一次后台任务 |
| 删除 sandbox | 先 flush 未完成 checkpoint（kick + 等到终态），失败则拒绝删除 |
| 重建 sandbox | 从 Freestyle `main` pull/恢复，不用 starter 覆盖已有仓库 |
| Console 外删 VM | observe 确认 `confirmedAbsent` → 清僵尸 `sandboxId` → 重建并 hydrate（未 push 改动不可恢复） |
| 切换 session 预览 | `ensureDesired(preview-ready)` 先 HTTP 探针缓存 URL；健康则复用；502/4xx 只重拉 `pnpm dev`（不删 VM、不 hydrate） |
| Export 下载 | 等 checkpoint 后走 Freestyle `contents.downloadZip`（某 revision 的源码树；**不含** `.git` 历史；不含未提交的 sandbox 改动） |
| 连接 GitHub Sync | `POST …/github-sync` `{ mode: "create_and_link" }`（未授权则返回 `authUrl`）→ 回调写 user binding → 建空仓 → `githubSync.enable`；断开走 `DELETE` |

## GitHub Sync（一键建仓并同步）

Agent / checkpoint **仍只写 Freestyle**。GitHub 侧由 Freestyle GitHub Sync 镜像。

用户流：

1. 运维：在 GitHub 创建/配置平台 App（与 Freestyle Dashboard → Git > Sync **同一 App**）；打开「安装时请求用户授权 (OAuth)」；Callback 可登记多条（本地 + 生产）。默认授权链接走 **安装页**（`/installations/new`，卸载后可重装；该路径忽略 `redirect_uri`，回跳用 App 设置里的第一条 Callback）。纯 OAuth + 显式 `redirect_uri` 仅作 fallback（`intent: "oauth"`），callback / redirect 按当前请求 Host 自动识别。配置下表环境变量即可
2. 用户（Daytona session）：预览栏 **同步到 GitHub** → 首次跳转安装/授权 → 回调后自动创建私有空仓并 enable Sync
3. 之后：turn checkpoint → Freestyle →（Freestyle）→ GitHub；用户在 GitHub push 亦会镜像回 Freestyle

高级：面板内「连接已有仓库」仍可手填 `owner/repo`（App 须已安装到该仓）。

边界：

- 首版只建**个人账号**私有空仓；仓名冲突自动加 `-2`、`-3` 后缀
- 分支分叉时 Freestyle **不 force-push**；需在 GitHub 或 Freestyle 侧手动合拢后再同步
- Local sandbox 不提供此 API / UI；无稳定登录 `userId` 时需先登录（授权挂在用户上）

## 存储

- Local：`.baby-lovable/sessions/<id>/git-repository.json` + `git-sync-tasks/`；用户授权 `.baby-lovable/users/<userId>/github-app.json`
- Supabase：`session_git_repositories`、`session_git_sync_tasks`、`user_github_app_bindings`
- Session GitHub 字段在 `repository` jsonb：`githubRepoName`、`githubSyncStatus`、`githubSyncError`

## 环境变量

```bash
FREESTYLE_API_KEY=
FREESTYLE_REPO_RETENTION_DAYS=30
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_INSTALL_URL=https://github.com/apps/<slug>/installations/new
# Optional
# GITHUB_APP_SLUG=
```

Daytona 模式缺少 `FREESTYLE_API_KEY` 时创建 session 直接失败，不会静默退回 sandbox-only。
