# Freestyle Git 真相源

Daytona 会话以 Freestyle 私有仓库的 `main` 为代码持久化真相源。Local 模式仍使用本机 workspace，不调用 Freestyle。

## 行为摘要

- 一个 session → 一个 Freestyle 私有仓库（`session_git_repositories`）
- Agent 只改 sandbox 文件，不获得 Git 工具；`.git` 受 `protected-paths` 保护
- 每轮结束（完成 / 失败）后平台自动 `status → add → commit → push`
- Git 操作只走 Daytona SDK `sandbox.git.*`，禁止 `process.executeCommand("git …")`
- 聊天输入框只看 `run` 状态；`sourceControl` 单独投影同步中/失败/冲突
- Web UI（Daytona）：预览栏状态芯片 + **History** 只读版本列表（`GET /api/sessions/:id/versions`）；暂不支持 revert

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

## 存储

- Local：`.baby-lovable/sessions/<id>/git-repository.json` + `git-sync-tasks/`
- Supabase：`session_git_repositories`、`session_git_sync_tasks`

## 环境变量

```bash
FREESTYLE_API_KEY=
FREESTYLE_REPO_RETENTION_DAYS=30
```

Daytona 模式缺少 `FREESTYLE_API_KEY` 时创建 session 直接失败，不会静默退回 sandbox-only。
