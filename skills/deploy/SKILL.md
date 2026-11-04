---
name: deploy
description: Prepare and verify publication through the host Backend Publish action, including linked backend environment, Auth redirects, and Stripe webhooks. Use when the user asks to go live or ship.
---

# Publish / deploy

Public deployment is owned by **Backend → Publish**. Users connect their Vercel account and explicitly select a Team. The host exports an immutable Freestyle checkpoint and creates a production deployment in that user's Vercel Project with this app's linked Supabase/Stripe environment. All new publications use Vercel; Freestyle stores source only. Keep source changes ready for the host; do not run `vercel deploy`, start a second dev server, request a user's Vercel token in chat, or invent a hosting URL.

## Before publishing

1. Call `backend` action `status` and check the services the application actually needs. Resolve missing links before claiming the app is ready.
2. Complete source edits and run `checkPreview`. Inspect compile errors and fix them. A ready preview alone does not verify production builds or external service behavior.
3. For Supabase, read the `supabase` skill and use `backend` to apply required migrations, configure Auth, create buckets/policies, and deploy any required Edge Functions. Do not replace this setup with mock persistence.
4. For Stripe, read the `stripe` skill. Implement authenticated Checkout creation, signature verification, and persistent/idempotent fulfillment. Use test mode until a live launch is requested.
5. Keep credentials out of source and tool output. The starter ignores `.env*`; retain that protection. Ensure required product/price IDs and other app configuration are supplied through supported configuration or database rows.
6. Wait for source control to finish syncing the latest edits to Freestyle `main`. If the host reports pending/error state, resolve it before publication so the deployment contains the version just checked.
7. In **Backend → Publish**, have the user connect Vercel, explicitly select and save a Team, and click **Publish to Vercel**. Missing Vercel authorization has no alternative publishing path. Report a public URL only after the host reports `READY` with the project's stable production URL.

## After publishing

- Read `backend` action `status` to obtain the actual published URL and deployment result. Verify the public app independently of the dev preview when a fetch facility is available.
- For Supabase Auth, call `backend` action `configure_auth` again so the host configures the trusted published origin and callback URLs. Check email confirmation, callback code exchange, and logout on the intended domain. Keep preview redirects only as needed; do not add broad wildcard redirects.
- For Stripe, call `backend` action `configure_stripe_webhook` once the webhook route is published. The host registers the endpoint for the trusted public URL and stores its signing secret. If configuration changed the injected environment, republish so the running deployment receives it before attempting delivery.
- Verify the matching Stripe mode and signed webhook fulfillment in test mode. Publishing does not itself establish that a payment flow or Auth callback works.
- If publication fails, preserve the deployment error, fix the source/configuration problem, and ask the user to republish. Distinguish build success, successful rollout, and verified product behavior in the final response.

The host reuses the same Vercel Project and production domain on later publications so Auth and Stripe callbacks keep a stable address. Confirm the returned URL after publication. Background publishing continues after the browser closes. If the outcome is uncertain, use **Check deployment status**; the host retains the active slot and reconciles the original request rather than creating another deployment. Reconnect Vercel if authorization expired. Historical deployments and rollbacks remain available in the user's Vercel dashboard; old Freestyle publications are read-only.
