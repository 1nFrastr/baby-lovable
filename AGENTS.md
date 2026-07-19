<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# baby-lovable — WorkflowAgent App Builder

**baby-lovable** is an AI-powered Next.js app builder. Users describe an app in chat; a **builder agent** edits an isolated per-session workspace and verifies changes against a live dev-server preview — without manual UI testing.

This repo has two layers:

| Layer | Path | Role |
| --- | --- | --- |
| **Host app** | `src/` | Next.js UI, API routes, CLI, WorkflowAgent, sandbox/dev-server management |
| **Generated apps** | `.baby-lovable/sessions/<id>/workspace/` | Per-session Next.js projects scaffolded from `templates/nextjs-starter` |

Stack: Vercel AI SDK v7 + WorkflowAgent + Workflow DevKit — `ai@7`, `@ai-sdk/workflow@1`, `workflow@4`, `@ai-sdk/react@4`, Next.js 16 with `withWorkflow()`.

**Before writing agent/workflow code**, read `.cursor/skills/ai-sdk-v7-workflow-agent/SKILL.md`.

## `.baby-lovable/` — runtime data (gitignored)

Default data root: `.baby-lovable/` (override with `BABY_LOVABLE_DATA_DIR`).

```
.baby-lovable/
└── sessions/
    └── sess_<id>/
        ├── session.json      # title, timestamps, sandboxMode, full UIMessage history
        ├── agent.log         # CLI per-turn trace file (optional; Web uses stdout)
        └── workspace/        # the generated Next.js app (agent's sandbox)
            ├── src/app/…
            ├── package.json
            └── .next/        # dev build output after preview boot
```

- **`session.json`** — durable chat + tool-call history. Inspect it to see exactly what the agent did (tool inputs/outputs, errors, token of conversation).
- **`agent.log`** — CLI turns mirror trace to this file. **Web UI** does not write it (avoids log workflow steps); use tagged stdout instead (see below).
- **`workspace/`** — the app under construction. Read/edit files here to verify codegen, run commands, or debug compile issues.
- Sessions are created on first use (web UI or CLI). Reuse a session with `-s <id>` to keep history and workspace state.

## CLI — headless agent runner (preferred for AI verification)

The CLI runs the **same** builder agent, tools, and system prompt as the web app, but streams a structured trace to the terminal. Use it for end-to-end validation without opening the browser.

```bash
# Prerequisites: copy .env.example → .env.local, set AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN)

npm run agent -- -h                          # help
npm run agent -- -l                          # list sessions
npm run agent -- -p "创建一个待办事项应用"    # one-shot: run one turn, then exit
npm run agent -- -s sess_abc123 -p "加渐变色" # resume session + one-shot
npm run agent                                # interactive REPL (new session)
npm run agent -- -s sess_abc123              # interactive REPL on existing session
```

### CLI flags

| Flag | Description |
| --- | --- |
| `-p, --prompt <text>` | Single turn then exit (**one-shot mode**) |
| `-s, --session <id>` | Reuse existing session (history + workspace) |
| `--sandbox <mode>` | `local` (default) or `daytona` |
| `--max-steps <n>` | Max agent steps per turn (default 30) |
| `-l, --list` | List sessions |
| `-h, --help` | Show help |

### Run modes

1. **One-shot** (`-p`) — Best for automated / AI-driven testing. Creates or resumes a session, runs one agent turn, saves state, tears down the background dev server, and exits cleanly.
2. **Interactive REPL** (no `-p`) — Multi-turn chat in the terminal. Commands: `/exit`, `/quit`.
3. **Session resume** (`-s`) — Continue prior work; workspace files and `session.json` messages are preserved.

### CLI observability

The CLI logger (`src/cli/logger.ts`) prints timestamped, colorized events:

- `STEP` — model step start/end (finish reason, token counts)
- `TOOL` / `TOOL✓` / `TOOL✗` — tool call input, success output, or error
- `assistant ▸` — streamed model text
- `DONE` — turn summary (steps, duration, total tokens)

On each turn the runner also:

- Bootstraps preview in the background (`pnpm install` + `pnpm dev` in the session workspace)
- Saves merged messages back to `session.json`

## Web UI — optional visual check

```bash
npm run dev    # host app at http://localhost:3000
```

Chat + live preview iframe. Same sessions and workspaces as CLI. Use when you want a human visual pass; **do not require it** for agent verification.

**Web observability:** each chat turn emits a real-time trace to `npm run dev` stdout with the tag `[agent-trace] session=<id>` (e.g. `STEP`, `TOOL`, `DONE`, `WARN`). Filter without touching workflow steps:

```bash
npm run dev 2>&1 | grep 'agent-trace'
# or per session:
npm run dev 2>&1 | grep 'agent-trace.*session=sess_abc123'
```

Incomplete turns emit `WARN` lines (e.g. no `checkPreview`, `finishReason=tool-calls` with few steps).

## Builder agent tools & verification loop

Tools live in `src/tools/builder-tools.ts` (steps in `builder-tool-steps.ts`):

| Tool | Purpose |
| --- | --- |
| `readFile` / `writeFile` / `editFile` / `deleteFile` | Workspace file CRUD — **source only** (`src/**`, `public/**`, root configs); `.next`, `node_modules`, `.git` are blocked |
| `listFiles` / `searchFiles` | Discover project structure |
| `installPackage` / `installDependencies` | Add/remove packages or run `pnpm install` (whitelisted; no arbitrary shell) |
| `runCommand` | **Deprecated** — only `pnpm install/add/remove` allowed; rejects curl/ls/find/etc. |
| `checkPreview` | **Readiness gate** — HTTP probe only (`{ ok, status, url, httpStatus }`); does not read compile logs. Optional `restart: true` restarts the managed dev server (never delete `.next` manually). Not required after every small HMR edit once preview is ready. |

**Verification loop the agent (and you) should follow:**

1. Edit files with tools. After preview is ready, small edits rely on HMR; `writeFile` / `editFile` may return `compileError` when the log already shows a failure.
2. Before finishing any turn that edited files, call `checkPreview` until `ok: true` at least once (required on first turn). After preview is already ready, small HMR edits may skip end-of-turn check — still check after deps/config/large rewrites or when `compileError` appears.
3. If `compileError` is non-null, or `checkPreview` reports `httpStatus` >= 500, fix source code and re-check before finishing. Do not touch `.next/` or `node_modules/`; use `checkPreview({ restart: true })` if the preview cache looks corrupt.
4. Optionally `curl` the preview URL or read workspace source files to assert behavior.

Preview lifecycle is owned by `src/lib/sandbox/local/app-server.ts` / `daytona/app-server.ts` — agents must **not** run `pnpm dev` themselves.

### Orphan preview servers (CPU / heat)

Each session boots its own `pnpm dev` → `next dev` → `next-server` under `.baby-lovable/sessions/<id>/workspace/`. Processes are spawned **detached** so they can survive host restarts; if the host app's in-memory tracker is lost, old previews become **orphans** and keep consuming CPU (multiple instances stack linearly). Some orphans lose their session path in `ps` output (PPID=1); the cleanup script also matches by process **cwd**.

**Clean up orphans** (does not stop the host `npm run dev`):

```bash
npm run cleanup-previews              # kill all session preview dev servers
npm run cleanup-previews -- --dry-run # list what would be killed
npm run cleanup-previews -- --keep sess_abc123  # keep one active session
```

Run this when the machine heats up, after long agent runs, or before starting fresh testing. CLI one-shot (`-p`) tears down its session preview on exit; Web UI sessions do not auto-stop until cleanup or explicit `DELETE /api/sessions/<id>/preview`.

## AI agent playbook — full-chain test without manual UI

When implementing or validating changes to the builder itself:

1. **Run via CLI one-shot** so output is fully logged and the process exits:
   `npm run agent -- -p "<representative user prompt>"`
2. **Read artifacts on disk** (no browser needed):
   - `.baby-lovable/sessions/<id>/session.json` — tool calls, errors, assistant reply
   - `.baby-lovable/sessions/<id>/agent.log` — CLI step/tool trace (or grep `[agent-trace]` from Web dev stdout)
   - `.baby-lovable/sessions/<id>/workspace/src/**` — generated source
   - `.baby-lovable/sessions/<id>/workspace/.next/dev/logs/next-development.log` — compile details
3. **Assert preview health** — last `checkPreview` tool output in `session.json` should have `ok: true` (and preferably `httpStatus` < 500); or call `GET /api/sessions/<id>/preview` while the host app is running.
4. **Re-run on same session** (`-s <id> -p "…"`) to test iterative edits and regression fixes.
5. **List sessions** (`npm run agent -- -l`) to correlate IDs with titles and timestamps.

For host-app code changes (not generated apps), also run `npm run lint` and `npm run build` on the repo root.

## Key source paths

| Path | Purpose |
| --- | --- |
| `src/cli/` | CLI entry (`index.ts`), turn runner (`run-agent.ts`), logger |
| `src/workflow/builder-agent.ts` | Shared WorkflowAgent + system prompt |
| `src/workflow/builder-chat.ts` | Durable web workflow (`'use workflow'`) |
| `src/lib/session/store.ts` | Session CRUD + `session.json` persistence |
| `src/lib/sandbox/` | Local/Daytona sandbox, paths, dev-server |
| `scripts/cleanup-preview-servers.ts` | Kill orphaned session preview `next dev` processes |
| `src/tools/` | Builder tools and `'use step'` implementations |
| `templates/nextjs-starter/` | Workspace scaffold copied per session |
| `src/app/api/sessions/` | REST: chat stream, preview status |

## Environment

See `.env.example`:

- `AI_GATEWAY_API_KEY` — Vercel AI Gateway (or `VERCEL_OIDC_TOKEN`)
- `AI_MODEL` — default `minimax/minimax-m3`
