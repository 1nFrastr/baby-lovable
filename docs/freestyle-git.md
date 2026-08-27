# Freestyle Git source of truth

Every session uses Freestyle private-repo `main` as the durable source of truth for code; the Daytona working tree is a runtime projection.

## Behavior summary

- One session → one Freestyle private repository (`session_git_repositories`)
- The Agent only edits sandbox files and does not get Git tools; `.git` is protected by `protected-paths`
- After each turn ends (success / failure) the platform automatically runs `status → add → commit → push`
- Git operations go only through Daytona SDK `sandbox.git.*`; `process.executeCommand("git …")` is forbidden
- The chat input only looks at `run` status; `sourceControl` is projected separately for syncing / failed / conflict
- Web UI (Daytona): preview-bar status chip + read-only **History** version list (`GET /api/sessions/:id/versions`); revert is not supported yet
- **GitHub Sync (optional)**: install the platform App from the preview bar → pick one personal repo already authorized by the installation → Freestyle `githubSync.enable`; Freestyle handles two-way mirroring (no force-push)

## Key paths

| When | Behavior |
| --- | --- |
| Create Daytona session | Validate `FREESTYLE_API_KEY`; start durable `provisionFreestyleRepoWorkflow`; reconciler hydrates after creating the VM |
| Turn ends | Unlock UI → enqueue sync task → start durable `gitTurnCheckpointWorkflow` (do not wait for push) |
| Next turn writes files | `awaitPreviousCheckpoint` only waits; on a dead worker, CAS kicks a background task once |
| Delete sandbox | Flush unfinished checkpoint first (kick + wait for terminal state); refuse delete on failure |
| Recreate sandbox | Pull/restore from Freestyle `main`; do not overwrite an existing repo with the starter |
| VM deleted outside Console | observe confirms `confirmedAbsent` → clear zombie `sandboxId` → recreate and hydrate (unpushed changes are unrecoverable) |
| Switch session preview | `ensureDesired(preview-ready)` HTTP-probes the cached URL first; reuse if healthy; on 502/4xx only relaunch `pnpm dev` (do not delete VM or hydrate) |
| Export download | After checkpoint, use Freestyle `contents.downloadZip` (source tree at a revision; **does not** include `.git` history; does not include uncommitted sandbox changes) |
| Connect GitHub Sync | GitHub App Setup callback only stores installation metadata → `GET …/github-sync/repositories` lists authorized repos → `POST …/github-sync` `{ repositoryId }` re-validates then `githubSync.enable`; disconnect via `DELETE` |

## GitHub Sync (pick an empty repo and sync)

Agent / checkpoint **still write only to Freestyle**. The GitHub side is mirrored by Freestyle GitHub Sync.

User flow:

1. Ops: create/configure the platform App on GitHub (the **same App** as Freestyle Dashboard → Git > Sync); turn off “Request user authorization (OAuth) during installation”; set Setup URL to `https://<host>/api/github/app/setup` and enable **Redirect on update**. The GitHub App only needs Contents R/W and Metadata — not Administration create-repo permission
2. User (Daytona session): preview bar **GitHub** → install the App and pick an existing repo on GitHub → back in the app, choose an empty repo with no commits from the dropdown → connect; if there is no empty repo, jump to GitHub to create one
3. Afterward: turn checkpoint → Freestyle → (Freestyle) → GitHub; user pushes on GitHub are also mirrored back to Freestyle

Boundaries:

- v1 only supports the **personal account** installation for the current Supabase GitHub login identity; org repos are not supported
- The platform does not create GitHub repos and does not accept a hand-typed `owner/repo`; the dropdown only shows empty repos, and POST re-checks that the repo has no commits after receiving `repositoryId`
- App JWT is used only to read the installation; short-lived installation tokens are used only to list/validate repos and are never stored. The platform does not obtain or store a GitHub user access token
- On branch divergence Freestyle **does not force-push**; sync again after manually reconciling on GitHub or Freestyle
- Installation ownership always binds to the current Supabase user

## Preview Console log consistency

- Daytona Console identifies the current log source with `generation + devSessionName + devCmdId`; after a service restart or an externally replaced command, identity must switch and old process logs must be cleared
- Before using a persisted `devCmdId`, validate it still belongs to the current Daytona session; on invalidation, fall back to the latest active command and write it back
- On disconnect, keep existing logs and pause the connection; after reconnect, take a snapshot of the current command first, then continue follow
- stdout/stderr are clearly labeled; the browser keeps only a bounded recent log window and hints on truncation; Clear keeps the current command watermark so reconnect does not restore cleared old content

## Storage

- Supabase: `session_git_repositories`, `session_git_sync_tasks`, `user_github_app_installations` (no tokens); local Host uses the same storage
- Session GitHub fields live under `repository` jsonb: `githubRepoName`, `githubSyncStatus`, `githubSyncError`

## Environment variables

```bash
FREESTYLE_API_KEY=
FREESTYLE_REPO_RETENTION_DAYS=30
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALL_URL=https://github.com/apps/<slug>/installations/new
# Optional
# GITHUB_APP_SLUG=
```

If `FREESTYLE_API_KEY` is missing, session creation fails immediately and does not silently fall back to sandbox-only.
