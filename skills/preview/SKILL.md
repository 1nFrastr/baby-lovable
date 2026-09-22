---
name: preview
description: Preview readiness and Next.js dev logs. Use when checkPreview fails, HTTP is 500, or you need compile/runtime error text.
---

# Preview

HTTP readiness is the **`checkPreview` tool** (platform-owned). Do not start the dev server.

1. Call `checkPreview` until `ok: true` / `status: ready` with `httpStatus` < 500 (required on the first turn that edited files).
2. HTTP 502/503 / `installing` / `starting` = wait and call again. Not a code error.
3. HTTP 500 = app is up but broken. Read logs, fix source, `checkPreview` once more.

Logs are mirrored to `.baby/logs/preview.log` (never read `.next`):

```bash
tail -n 40 .baby/logs/preview.log
tail -n 40 .baby/logs/preview.log | rg -n "Error|Failed|Module not found"
```

Corrupt preview cache: `checkPreview({ restart: true })`. Never `rm -rf .next` or `pnpm dev`.
