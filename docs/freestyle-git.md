# Freestyle Git 真相源

所有会话都以 Freestyle 私有仓库的 `main` 为代码持久化真相源，Daytona 工作树是运行时投影。

## 行为摘要

- 一个 session → 一个 Freestyle 私有仓库（`session_git_repositories`）
- Agent 只改 sandbox 文件，不获得 Git 工具；`.git` 受 `protected-paths` 保护
- 每轮结束（完成 / 失败）后平台自动 `status → add → commit → push`
- Git 操作只走 Daytona SDK `sandbox.git.*`，禁止 `process.executeCommand("git …")`
- 聊天输入框只看 `run` 状态；`sourceControl` 单独投影同步中/失败/冲突
- Web UI（Daytona）：预览栏状态芯片 + **History** 只读版本列表（`GET /api/sessions/:id/versions`）；暂不支持 revert
- **GitHub Sync（可选）**：预览栏安装平台 App → 从 installation 已授权的个人仓库中选择一个 → Freestyle `githubSync.enable`；Freestyle 负责双向镜像（不做 force-push）

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
| 连接 GitHub Sync | GitHub App Setup 回调只保存 installation 元数据 → `GET …/github-sync/repositories` 列出已授权仓库 → `POST …/github-sync` `{ repositoryId }` 二次校验后 `githubSync.enable`；断开走 `DELETE` |

## GitHub Sync（选择空仓库并同步）

Agent / checkpoint **仍只写 Freestyle**。GitHub 侧由 Freestyle GitHub Sync 镜像。

用户流：

1. 运维：在 GitHub 创建/配置平台 App（与 Freestyle Dashboard → Git > Sync **同一 App**）；关闭「Request user authorization (OAuth) during installation」；Setup URL 配为 `https://<host>/api/github/app/setup` 并开启 **Redirect on update**。GitHub App 只需 Contents R/W 与 Metadata，不需要 Administration 建仓权限
2. 用户（Daytona session）：预览栏 **GitHub** → 安装 App 并在 GitHub 选择已有仓库 → 回到应用后从下拉列表选择一个没有 commit 的空仓库 → 连接；没有空仓库时可跳转 GitHub 新建
3. 之后：turn checkpoint → Freestyle →（Freestyle）→ GitHub；用户在 GitHub push 亦会镜像回 Freestyle

边界：

- 首版只支持当前 Supabase GitHub 登录身份对应的**个人账号** installation，不支持组织仓库
- 平台不创建 GitHub 仓库，也不接受手填 `owner/repo`；下拉只显示空仓库，POST 接收 `repositoryId` 后会再次校验仓库没有 commit
- App JWT 只用于读取 installation；短期 installation token 只用于列出/校验仓库，均不落库。平台不获取或存储 GitHub user access token
- 分支分叉时 Freestyle **不 force-push**；需在 GitHub 或 Freestyle 侧手动合拢后再同步
- installation 归属始终绑定当前 Supabase 用户

## Preview Console 日志一致性

- Daytona Console 以 `generation + devSessionName + devCmdId` 标识当前日志源；服务重启或外部替换命令后必须切换身份并清除旧进程日志
- 持久化 `devCmdId` 使用前会校验仍属于当前 Daytona session；失效时回退到最新活动命令并写回
- 断网时保留已有日志并暂停连接，恢复联网后先取当前命令快照再继续 follow
- stdout/stderr 明确标识；浏览器只保留最近的有界日志，截断会提示；Clear 保留当前命令水位，重连不会恢复已清除的旧内容

## 存储

- Supabase：`session_git_repositories`、`session_git_sync_tasks`、`user_github_app_installations`（无 token）；本地 Host 使用相同存储
- Session GitHub 字段在 `repository` jsonb：`githubRepoName`、`githubSyncStatus`、`githubSyncError`

## 环境变量

```bash
FREESTYLE_API_KEY=
FREESTYLE_REPO_RETENTION_DAYS=30
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALL_URL=https://github.com/apps/<slug>/installations/new
# Optional
# GITHUB_APP_SLUG=
```

缺少 `FREESTYLE_API_KEY` 时创建 session 直接失败，不会静默退回 sandbox-only。
