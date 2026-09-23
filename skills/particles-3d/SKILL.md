---
name: particles-3d
description: WebGL particles driven by webcam hand gestures (R3F + MediaPipe). Use for interactive hero fields, point clouds, or gesture-controlled 3D atmosphere.
---

# 3D particles + hand gestures

Stack: **`three`** + **`@react-three/fiber`** + **`@react-three/drei`**, driven by **MediaPipe Hands** (or Tasks Vision hand landmarker) from `getUserMedia`. One `<Canvas>` per view; client-only mount (`"use client"` / `dynamic(..., { ssr: false })`).

```bash
pnpm add three @react-three/fiber @react-three/drei @mediapipe/tasks-vision
pnpm add -D @types/three
```

## Gesture → motion

- Request camera with a clear permission affordance; never assume access. Mirror the preview optionally; do not upload frames off-device
- Map a few landmarks (wrist / index tip / pinch) to particle attractors, swirl strength, or color — keep the mapping readable
- Smooth landmark streams (lerp / EMA); drop frames if confidence is low
- If camera denied or `prefers-reduced-motion`, fall back to a calm idle animation

## Performance

- Prefer `InstancedMesh` or one `Points` buffer over thousands of meshes
- Animate in `useFrame`; mutate refs — no big allocations per frame
- Cap counts on mobile; dispose GPU resources on unmount

## Design

Particles + gesture are the hero moment, not the whole product. Keep CTAs readable above the field.
