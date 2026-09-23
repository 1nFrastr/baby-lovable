---
name: remotion
description: Programmatic video with Remotion in React. Use for compositions, frame-driven motion, sequences, or embedding a Player in the Next.js app.
---

# Remotion

Drive visuals from **`useCurrentFrame()`** + `interpolate` / `spring` — not CSS transitions or `setInterval`. Layout with `AbsoluteFill`; scene cuts with `Sequence` / `Series`.

## In this sandbox

```bash
pnpm add remotion @remotion/player
```

Embed `<Player />` for in-app preview. Do **not** start Remotion Studio or a long-running render server — the managed preview owns the process. Server-side MP4 export is out of scope unless the user asks for a render path later.

## Markup habits

- Keep compositions pure: props in, frames out; no network in the composition tree
- Prefer `@remotion/media` patterns for video/audio when available; size assets for the composition
- `calculateMetadata` when duration/dimensions depend on props
- Client components only where the Player mounts (`"use client"`)

If APIs are unclear, use the `web` skill against remotion.dev docs — do not invent deprecated props.
