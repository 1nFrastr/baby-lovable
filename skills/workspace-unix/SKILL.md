---
name: workspace-unix
description: Inspect the Next.js workspace with ls, find, and ripgrep. Use when listing files, searching filenames or file contents, or composing unix pipelines.
---

# Workspace unix

Prefer **one** `exec` pipeline over many round-trips.

## List and filenames

```bash
ls -la src
find src -name '*.tsx' | head -50
find src/components -name '*Button*'
```

## Content search (ripgrep)

```bash
rg -n "TODO" src --glob '*.tsx' | head -50
rg -l "useState" src
rg -n "bg-foreground/5" src --glob '*.css'
```

Use `-g '!.next' -g '!node_modules' -g '!.git'` only if you search from `.`. Prefer `src` / `public` as the path.

## Do not

- Edit source with `sed -i`, redirects (`>`), `tee`, `rm`, or `mv` — use `editFile` / `writeFile` / `deleteFile`
- Touch `.next`, `node_modules`, or `.git`
- Run `pnpm dev` / `next dev`
