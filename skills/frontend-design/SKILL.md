---
name: frontend-design
description: Distinctive UI visuals for new or restyled pages. Use before writing or heavily editing UI so the result matches the brief and avoids generic AI template looks.
---

# Frontend design

**Before writing UI code**, fix a one-line plan (can be private to the turn):

1. **Subject** — what this is for (audience + craft), not a generic “SaaS”
2. **Look** — one aesthetic sentence tied to that subject (materials, era, mood)
3. **Tokens** — 4–6 CSS vars (`--bg`, `--fg`, `--accent`, `--muted`, display/body fonts)
4. **Hero** — the single dominant visual idea

If the plan would fit any other brief, revise it. Then build to the plan; do not invent a second aesthetic mid-page.

## First viewport

One composition: brand at hero strength, one headline, one short line, one CTA group, one dominant visual. No stats strips, card grids, promo chips, or floating badges on the hero. Full-bleed imagery beats inset media cards.

## Craft rules

- Expressive fonts over Inter / Roboto / Arial / system stacks
- Atmosphere from real imagery, texture, or a deliberate gradient — not a flat fill alone
- Spend boldness once; keep surroundings quiet. Cards only when they contain a real interaction
- Copy in the subject’s voice; no lorem, fake metrics, or “feature filler”

## Avoid (slop tells)

- Purple→indigo kits; cream + terracotta serif; neon-on-near-black; broadsheet hairlines
- Card-everything; identical radius + soft shadow; pill clusters; emoji chrome
- EVERY SECTION fade-up; ALL-CAPS eyebrows on every block; accenting one random headline word

## Motion & ship

2–3 intentional moments only. Honor `prefers-reduced-motion`. Mobile + desktop, readable contrast. Pair with `storefront` / `personal-site` when the product shape is clear.
