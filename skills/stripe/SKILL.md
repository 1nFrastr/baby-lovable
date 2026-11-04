---
name: stripe
description: Implement Stripe Checkout or Payment Element with linked keys, verified webhooks, and persistent fulfillment. Use when the generated app needs real payments or subscriptions.
---

# Stripe (generated app)

## Connection and credentials

Call `backend` action `status` first. The app owner's Stripe connection is managed through Vercel Connect in **Backend → Stripe**. The host resolves the current server key when refreshing preview settings or publishing, then injects server-only `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` when configured. `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is optional and only supplied when separately configured. Never read, print, copy, or commit credential values. Never pass a host Vercel token or connector-management authority into the generated app. After key rotation, refresh preview connections and publish again; existing app processes do not fetch keys dynamically.

Use test mode while building. If disconnected, tell the user to link Stripe. Do not silently use live mode, invent credentials, or create real charges as a verification step. Keep server Stripe code in modules marked `import "server-only"`.

```bash
pnpm add stripe @stripe/stripe-js
```

## Checkout and Payment Element

- Create Checkout Sessions or PaymentIntents in server Route Handlers. Authenticate the buyer where the product requires accounts and authorize access to the order/subscription.
- Derive prices, currency, product IDs, and allowed quantities from a trusted server catalog or database. Never accept an arbitrary amount, price ID, user ID, success URL, or customer ID from the client.
- Use stable idempotency keys for retries of the same logical order. Persist the order and its ownership before creating payment resources; save the resulting Stripe IDs for reconciliation.
- Prefer hosted Checkout and redirect the browser to the returned session URL; it needs no browser publishable key. Do not install or initialize Stripe.js for this flow. Payment Element requires a separately configured publishable key; report that requirement if absent. For Payment Element, return only the client secret required by that buyer. Never return the API secret key.
- Derive return URLs from the intended app origin; validate against trusted configured origins rather than accepting client-supplied URLs or unchecked forwarded headers. Preview URLs are temporary; update the production flow after publishing.
- Keep product/price IDs in server configuration or database rows. The managed integrations environment does not imply support for arbitrary custom env variables; do not leave essential price IDs in env variables that the host cannot supply.

## Webhooks and fulfillment

1. Implement `src/app/api/stripe/webhook/route.ts` before configuring the endpoint. The default URL path is `/api/stripe/webhook`.
2. Read the raw body with `await request.text()` and the `stripe-signature` header. Require `STRIPE_WEBHOOK_SECRET` and verify with `stripe.webhooks.constructEvent` before processing. Missing configuration must return an error; never fall back to parsing unsigned events. Missing/invalid signatures must return 400.
3. Process only the events the product needs. Match the expected mode, payment status, order/customer IDs, currency, and amount against persisted records. For delayed payment methods, handle asynchronous success/failure; `checkout.session.completed` alone does not always mean payment succeeded. Subscription access must follow the relevant invoice and subscription lifecycle events.
4. Persist processed event IDs and fulfillment updates transactionally with a uniqueness constraint. Duplicate delivery or out-of-order events must not grant entitlements twice or regress a newer subscription state. Keep pending work retryable and return success only after the event is durably handled or queued.
5. Fulfill from verified server events. A success-page visit or client assertion must never mark an order paid or grant access. Show a pending state while the webhook is outstanding.
6. After the app has a public deployment, call `backend` with `{"action":"configure_stripe_webhook"}` (no extra parameters). The host uses the trusted published URL and fixed `/api/stripe/webhook` path; it stores the endpoint signing secret without returning it to the model. Registered events are `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Other event types require additional provider setup; do not claim those flows are configured. Redeploy after configuration if the running deployment needs the newly stored environment value, and reconfigure if the deployment domain or Stripe mode changes.

A webhook secret belongs to a particular endpoint and mode. Do not assume a secret pasted for another endpoint will verify events delivered to this deployment. If a stable public URL is unavailable, say that webhook delivery/fulfillment is pending publication.

## Storefront and verification

For catalog/cart UI, follow the `storefront` skill. Replace mock checkout only after server routes and persistent order state exist. Never present payment as complete because the preview compiles.

Call `checkPreview` after adding routes. In test mode, verify Checkout creation, missing/invalid signature rejection, a signed event, duplicate event delivery, and persisted fulfillment when the necessary testing facilities are available. Report which flows were verified and any provider setup still required. Never create a live charge without the user's explicit instruction.
