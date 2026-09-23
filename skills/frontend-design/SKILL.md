---
name: frontend-design
description: Distinctive UI visuals — palette, type, layout, motion. Use when building or restyling pages so they do not look like generic AI templates.
---

# Frontend design

Pick one clear aesthetic for the brief (industry + audience), then commit. Do not remix the same purple SaaS / cream-serif / neon-dark kit on every project.

## First viewport

One composition: brand (hero-level), one headline, one short line, one CTA group, one dominant visual. No stats strips, card grids, or promo chips in the hero. Full-bleed imagery beats inset media cards.

## Tokens

Define a small CSS variable set early (`--bg`, `--fg`, `--accent`, `--muted`, fonts). Prefer expressive fonts over Inter/Roboto/system. Atmosphere via gradient, texture, or real imagery — not a flat single fill alone.

## Avoid

- Purple-on-white / indigo glow defaults; warm cream + terracotta serif; broadsheet hairline columns
- Card-everything layouts; hero overlays (badges, floating chips); pill clusters; emoji decoration
- Fade-up on every section; identical soft shadows and one radius on all boxes

## Motion

2–3 intentional moments (page-load or interaction feedback). Honor `prefers-reduced-motion`. Motion answers hierarchy, not noise.

## Ship bar

Responsive mobile + desktop, readable contrast, real or plausible copy for the subject — not "lorem" or feature-filler.
