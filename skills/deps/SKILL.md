---
name: deps
description: Add or remove npm packages with pnpm in the sandbox. Use when the user needs a new dependency or after editing package.json.
---

# Dependencies

Platform package manager is **pnpm**. A successful `exec` of add/remove/install restarts the managed preview.

```bash
pnpm add lucide-react
pnpm add -D zod
pnpm remove lucide-react
pnpm install
```

Or the bundled scripts:

```bash
bash .baby/skills/deps/scripts/add.sh lucide-react
bash .baby/skills/deps/scripts/add.sh --dev zod
bash .baby/skills/deps/scripts/remove.sh lucide-react
bash .baby/skills/deps/scripts/install.sh
```

Then call `checkPreview`. Never run `pnpm dev`.
