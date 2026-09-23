---
name: storefront
description: Ecommerce UI patterns — catalog, product detail, cart, checkout skeleton. Use when building shops, product landing pages, or merchandising flows.
---

# Storefront

Typical surfaces: home merchandising → collection/grid → product detail (PDP) → cart → checkout. Ship the path the shopper needs; skip admin dashboards unless asked.

## Merchandising

- Image-first product cards: photo, name, price, one clear action — not dense feature cards
- PDP: gallery, price, variants, primary CTA, short proof (shipping/returns) — one job per block
- Trust near money decisions (reviews, policies), not floating promo stickers on the hero

## Commerce UX

- Cart shows line items, quantity, subtotal; empty cart invites continue shopping
- Checkout as a short linear form (contact → shipping → pay placeholder). Mock pay is fine; do not invent real payment credentials or scrape gateways
- Persist cart in `localStorage` or simple client state for demos; keep types for Product / CartLine

## Visual

Follow `frontend-design` for brand. Product photography (or strong placeholders) is the anchor — not abstract gradients alone.
