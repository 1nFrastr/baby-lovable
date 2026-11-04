# Generated-app backends with Vercel Connect

These connections belong to an app built by baby-lovable. They never reuse the builder host's Supabase database or Stripe billing account. Vercel Connect holds provider grants and refresh credentials. The host stores app-to-connector references, safe status, and encrypted webhook signing secrets; generated apps receive only their own runtime configuration.

## User journey

1. Open the **Backend** tab beside **History**, choose **Connections**, select **Connect Supabase account**, authorize, and choose a project. The builder can create tables and permissions, configure sign-in callbacks, create file spaces, and deploy functions in that project.
2. Describe the requested behavior in chat. The builder checks status, preserves reviewable migration/function source under `src/backend/`, and calls the host `backend` tool. Authorization is separate from a verified application flow.
3. Open **Backend → Payments** and select **Connect Stripe**. With a dedicated managed-key connector assigned, the host verifies that account without asking for a pasted secret. With a shared user-key connector, Connect asks the app owner for a restricted key and stores it on Vercel. These are different onboarding methods; do not describe user-key entry as managed key issuance.
4. Build and verify hosted Stripe Checkout in test mode. Hosted Checkout needs a server key and a redirect to the returned session URL; it needs no browser publishable key. Payment Element requires a separately configured publishable key and is not automatically enabled by a Connect grant.
5. Open **Backend → Publish**, connect Vercel, explicitly select and save a Team, and choose **Publish to Vercel**. The host exports a pinned Freestyle checkpoint and tracks a production deployment asynchronously in that Team. Then configure the permanent Auth callback and payment notification endpoint. Publish again when a webhook signing secret is newly added. Later publications reuse the same Vercel Project and production URL. See [Vercel publication](vercel-publish.md) for OAuth permission prerequisites and live acceptance.

Users still authorize their accounts, need a Supabase project, and complete Stripe onboarding. Account creation/KYC, project provisioning, SMTP/social-login credentials, and arbitrary Edge Function secrets are outside these operations.

## Database browser

**Backend → Database** opens each table on its **Data** tab. Browse read-only rows with 25, 50, or 100 records per page, click a column header to sort, or apply a column filter (contains, equals, does not equal, NULL, or not NULL). Click a cell to inspect and copy its full text or formatted JSON. The **Structure** tab shows column types, defaults, nullability, primary/foreign keys, and RLS status. Switching between Data and Structure preserves the current filters and page; selecting another table starts a fresh view.

This is a project-owner administration view, so rows are read with the app's authorized Management API grant rather than an app user's RLS context. Access is checked against the session owner and bound Supabase project. System schemas and the builder's own metadata project are excluded. Requests accept table/column selections and bounded browse options, never arbitrary SQL or a client-selected project. Data queries use read-only execution; row filters stay in POST bodies rather than URLs, and row values are never logged. A paused project must be resumed in Supabase before browsing its tables.

## Authentication users and settings

**Backend → Authentication** opens the **Users** tab, a read-only directory of the app's registered users. It shows user ID, email address, email verification state, creation time, and last sign-in time. Search by email or user ID and browse 25, 50, or 100 users per page, newest first. Anonymous users and accounts that have never signed in are labeled explicitly. The **Settings** tab contains email verification, signup, anonymous sign-in, and callback URL controls; switching tabs preserves an unsaved settings draft.

The user directory has a dedicated fixed query against `auth.users`, separate from the general database browser. It returns only the allowlisted directory fields, excludes soft-deleted users, and never selects password hashes, tokens, or arbitrary user metadata. User searches use same-origin POST requests with no-store responses, owner checks, and the app's authorized Management API grant. Auth's internal tables remain excluded from general table browsing. A paused database must be resumed in Supabase to load the user directory.

## Operator setup

Apply the integration migrations locally with `supabase db push --local`, including `20261103020000_vercel_connect.sql` and `20261103030000_connect_stripe_account.sql`. Production schema changes go through GitHub Actions. Configure a stable `INTEGRATION_SECRETS_KEY` (32 bytes, hex/base64) for authorization cookies, webhook signing secrets, and legacy/manual keys. Back it up; there is no automatic encryption-key migration.

The host project must be linked to each connector for the intended Vercel environment. Runtime user authorization uses the **host project's OIDC identity**. Local development needs `vercel link` and `vercel env pull`; refresh an expired development OIDC token. Do not copy production environment values into the local host's Supabase configuration. A personal Vercel access token cannot impersonate arbitrary generated-app owners. `VERCEL_CONNECT_ACCESS_TOKEN` is an optional host-only scoped credential for dedicated app-subject connectors, never a replacement for delegated-user OIDC.

### Supabase

Register and publish a Supabase OAuth app with callback **`https://connect.vercel.com/callback`**. Select permissions in Supabase's OAuth app settings: Projects read, Secrets read, Database read/write (executing SQL requires write), Auth read/write, Edge Functions read/write, and any organization-read permission required by project listing. Do not invent OAuth scope strings; Supabase's authorization-time scope parameter is deprecated. Choose only permissions the enabled operations require. Permission changes require authorization again.

Create a REST Management API OAuth connector, not an MCP connector. The one-time setup utility configures the documented authorization/token endpoints, PKCE S256, basic client authentication, user authorization and refresh, and attaches the host project. It never prints the client secret.

Supply these only in the operator's setup environment:

```text
VERCEL_CONNECT_SETUP_TOKEN=<scoped operator token>
VERCEL_TEAM_ID=<team id>
VERCEL_PROJECT_ID=<host project id>
VERCEL_CONNECT_SETUP_ENVIRONMENTS=development
CONNECT_SETUP_SUPABASE_CLIENT_ID=<Supabase OAuth client id>
CONNECT_SETUP_SUPABASE_CLIENT_SECRET=<Supabase OAuth client secret>
```

```bash
npm run connect:setup -- --provider supabase
# After reviewing the setup, explicitly create and attach:
npm run connect:setup -- --provider supabase --apply
```

Set the returned ID as `VERCEL_CONNECT_SUPABASE_CONNECTOR` on the host and remove the one-time client/setup credentials. For preview/production, explicitly select the corresponding environments when setting up/attaching a connector. The host has no provider-code exchange or refresh-token writer in its request path. The old `/api/integrations/supabase/oauth/*` endpoints return 410. Old encrypted grants are retained for rollback, but are not used; existing OAuth links must reconnect through Connect.

### Stripe: dedicated managed key

The official Vercel CLI supports managed restricted Stripe keys:

```bash
vercel connect create stripe --connection-method managed-api-key --name app-UNIQUE_ID
vercel connect attach stripe/app-UNIQUE_ID --project HOST_PROJECT --environment production
```

Use the current CLI's service-specific help to choose supported permissions. Complete account consent in the returned setup flow. Each managed connector is dedicated to one generated app. Assign its returned opaque `scl_...` ID (or `stripe/...` UID) using the host operator utility:

```bash
# Verify only; reads the app and checks the connector, without assigning:
npm run connect:bind-stripe -- --session sess_ID --connector scl_ID
# Assign to that app after reviewing the account:
npm run connect:bind-stripe -- --session sess_ID --connector scl_ID --apply
```

Run against the intended metadata environment. The utility refuses active builder turns and existing linked Stripe accounts. A partial unique index prevents assigning the same app-scoped credential to two generated apps. Owners cannot supply connector IDs or subject IDs to browser APIs. No host/team token enters a generated workspace.

The managed setup flow is team administration. A supported public API for arbitrary customers to create independent managed-key accounts from one shared connector has not been established. This implementation deliberately requires operator assignment for managed keys; it does not send ordinary app users to a team administrator's setup page. For customer self-service today, use the following user-key option.

### Stripe: self-service user keys stored by Connect

The published Connect API supports API-key connectors with `data.subjectType = "user"`: each subject supplies its own key during authorization, and no connector-level key is shared. Create one with the setup utility:

```bash
npm run connect:setup -- --provider stripe
npm run connect:setup -- --provider stripe --apply
```

Use the same one-time team/project/setup-token variables as above; Supabase client credentials are not required. Set the returned ID as `VERCEL_CONNECT_STRIPE_CONNECTOR`. Its configuration uses `serviceUrls: ["https://api.stripe.com"]` and no initial secret values. Use a restricted test key while building. Enable only the needed Checkout/billing permissions, account and balance read for verification, and webhook endpoint read/write if using automatic notification setup.

The host verifies returned keys and their test/live mode through Stripe before saving a binding. The host pins the verified Stripe account ID; a key rotation that changes account or mode blocks runtime configuration and requires reconnection. A Connect reference alone is never enough to mark a payment flow working. The existing Advanced manual-key fallback remains for compatibility and uses encrypted local storage; it does not gain managed-key rotation.

## Identity and credential boundaries

Each delegated grant uses a server-derived subject: SHA-256 of the authenticated owner ID and generated-app session ID, with a fixed namespace. Two apps owned by one person have separate grants. Changing an account for one app therefore does not silently change another app's grant. Browser requests select only a provider; connector selection and identity come from host configuration or a persisted operator assignment.

Authorization starts with an authenticated same-origin POST. An encrypted HttpOnly, SameSite Lax, ten-minute cookie binds the owner, app, provider, connector, and random state. The callback rechecks current ownership, idle state, state and expiry. It requests a fresh token from Connect and probes the actual provider before accepting a connection. Browser callback parameters never carry provider credentials. Authorization cookies are cleared after callback. A completed/linked connection cannot be replaced by replaying an old callback; unlink before changing accounts.

Credential tables retain service-only grants and a composite foreign key enforcing session ownership. Browser status reads do not select ciphertext, request provider tokens, or include connector references. Connect-issued management/Stripe keys are never persisted to our credential tables. Webhook signing secrets still require encryption because Connect token retrieval does not replace Stripe signature verification.

## Runtime delivery and rotation

The host resolves fresh Connect credentials immediately before provider administration, preview startup/refresh, and publication. Supabase project keys are fetched through the authorized Management API; modern publishable/secret keys are preferred when returned, with legacy keys supported. Only that app's runtime keys enter its environment.

Generated applications run in Sandbox previews and Vercel production deployments in the owner's explicitly selected Team. Freestyle stores source and historical publications are read-only. They consume environment **snapshots**. They do not fetch Connect credentials dynamically, do not receive host OIDC/access tokens, and do not gain access to connector management. Rotation therefore requires **Refresh preview connections** and another publication. The managed-key rotation overlap is not a promise that an old published deployment updates itself.

The managed `.env.local` block preserves unrelated settings, escapes dotenv interpolation, excludes the file from Git, and refuses tracked/staged credential files. Synchronization errors block startup. Unlinking refreshes preview configuration but does not revoke provider grants or erase credentials from an already published deployment; revoke compromised credentials at the provider and republish. Supabase revocation also prevents automatic preview restart until authorization is restored; this is intentional fail-closed behavior.

New Vercel/Daytona Pro sandboxes allow `*.supabase.co` and `api.stripe.com`. Explicit egress overrides must allow these too; existing sandboxes may need recreation. Connect calls originate on the host, so generated apps need no Vercel API egress.

## Modules

| Module | Responsibility |
| --- | --- |
| `connect.ts` | SDK access, server-derived subjects, host identity, bounded waits, safe SDK errors |
| `credentials.ts` | On-demand provider credential resolution without persistent token copies |
| `service.ts` | Ownership, authorization cookie, connections, preview activation, publication |
| `store.ts` / `secrets.ts` | Service-only references/secrets, encryption, atomic publication claim |
| `runtime-env.ts` | Managed environment snapshot, Git protection, fail-closed synchronization |
| `supabase-management.ts` / `http.ts` | Fixed destinations, bounded requests, safe errors, no blind mutation retries |
| `backend.ts` / `migrations.ts` | App-scoped operations, turn fencing, transactional migration ledger and audit |
| `src/cli/setup-connect.ts` | Explicit one-time connector creation/attachment; default does not create |
| `src/cli/bind-stripe-connect.ts` | Operator assignment of a dedicated managed Stripe connector |

## Operations, observability and recovery

The builder still supports `status`, `inspect_schema`, `apply_migration`, `configure_auth`, `create_bucket`, `deploy_function`, and `configure_stripe_webhook`. Database migrations use stable names, content digests, transaction/advisory locks, and an exposed-table RLS gate. The gate does not prove policy correctness. Buckets default private and require MIME/size restrictions; policies are separate. Auth callbacks append exact trusted origins. Functions upload one bundled module and always enable JWT verification. Test JWT compatibility and handler authorization separately.

Webhook creation uses the published `/api/stripe/webhook`, documented Checkout/subscription/invoice events, stable idempotency, and encrypted endpoint-bound signing secrets. Saving that secret never persists a Connect-issued Stripe key. Missing secrets for existing endpoints require reconciliation, not blind recreation. Reauthorization or account changes may require reviewing existing webhook resources before setting up another endpoint.

`backend_operations` records operation IDs, provider/action/resource, content digest, timestamps, status and safe codes. `[backend]` logs correlate those operations. `[connect]` logs contain the app session, subject class and SDK token ID for correlation with Connect Observability, never provider tokens, vendor metadata or business rows. Failed SDK errors are translated to safe connection codes. An SDK call stops being awaited after 30 seconds; the SDK does not expose cancellation, so a remote authorization request may still complete. There are no automatic authorization/mutation retries.

Publication waits for source checkpoints, refuses tracked private env files, and reserves a durable Vercel publish job. The background workflow exports an exact commit, uploads files by SHA, and reconciles provider state with bounded exponential backoff. Uncertain provider outcomes retain the active slot to avoid duplicate deployments; **Check deployment status** recovers the original operation. Previous live URLs survive failed updates. The publish gate does not scan all source secrets or prove application authorization. See [Vercel publication](vercel-publish.md) for storage, recovery, environment conflict behavior and OAuth acceptance requirements.

## Verification

```bash
npm test
BABY_TEST_LOCAL_POSTGRES=1 npm test -- src/lib/integrations/migrations.test.ts
npm run lint
npm run build
npm run agent -- --max-steps 4 -p 'Inspect backend connection status. Do not edit files, create resources, publish, or start a payment.'
```

Tests cover subject/app isolation, project identity restrictions, callback authentication/state/expiry, provider credential validation, key rotation/mode changes, secret-free persistence, managed env protection, audit, and provider transport. Live acceptance requires an attached connector, owner consent, a dedicated generated-app Supabase project and a Stripe test account: verify anonymous/two-user RLS, Auth confirmation/callback/logout, private uploads, function authorization, Checkout, invalid/duplicate/out-of-order webhooks, fulfillment, and refresh/republish after rotation. Unit tests and an HTTP-ready preview do not establish those flows. Never test using live charges or the host database.

References: [Connect SDK](https://vercel.com/docs/connect/ts-sdk-reference), [Connect authentication](https://vercel.com/docs/connect/concepts/authentication), [Create connector](https://vercel.com/docs/rest-api/connect/create-a-connector), [Vercel OpenAPI](https://vercel.com/openapi.json), [Managed Stripe keys](https://vercel.com/changelog/vercel-connect-adds-managed-stripe-api-keys), [Supabase OAuth](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration).

### Create a dedicated Supabase project

After connecting Supabase, select an organization in the Backend panel and choose **Create or resume project setup**. The host creates the project, waits for it to become healthy, and binds it to the app. Supabase applies the selected organization's project limits and billing. Existing projects can still be linked separately.

Provisioning requires organization read and Projects write on the Supabase OAuth grant. Existing grants with Projects read only must be reauthorized after the OAuth app's permissions are updated. Apply the Supabase provisioning migration before enabling the flow. If a provider request has an unknown outcome, resume with the original organization; the host looks for the reserved project name instead of issuing another create request.
