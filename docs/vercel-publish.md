# Publish generated apps to Vercel

All new production publications use Vercel. Each app binds to one Project in a Team explicitly selected by its owner. Freestyle remains the durable Git source store; Sandbox remains the development preview. Existing Freestyle publication URLs are archived for read-only display. There is no Freestyle production fallback.

## Operator prerequisites

1. Apply `20261104020000_vercel_publish.sql` and `20261104030000_vercel_publish_dashboard.sql` locally with `supabase db push --local`. Production migrations are applied by the repository's GitHub Actions process, never from a laptop.
2. Configure the host's `INTEGRATION_SECRETS_KEY` for encrypted, short-lived authorization cookies. Vercel provider tokens are not stored in that key's encrypted tables, in browser state, or in generated-app environments.
3. Register a Vercel OAuth application and enable the required API permissions. **Sign in with Vercel API/Team resource permissions are currently documented as private beta.** A normal identity-only OAuth client is insufficient. Confirm access with Vercel before treating this integration as available to users.
4. Configure Team read, Projects read/write, Deployments read/write, Production Environment Variables read, and the domain-read access required by project domain lookup. Enable refresh-token issuance (`offline_access`) for background operations. Configure permissions on the OAuth application; do not invent OAuth scope strings for these resource permissions.
5. Create a REST OAuth connector and attach it to the **host** project and required environments. The connector's provider callback is supplied by Connect setup; the host callback `/api/integrations/connect/callback` is the post-authorization return URL, not the provider's registered OAuth callback.

Inspect current CLI help first:

```bash
vercel connect create vercel --help
vercel connect attach --help
```

The verified CLI supports:

```bash
# Keep credentials.json outside the repository; never commit or log its contents.
# Its OAuth data contains clientId and clientSecret from your Vercel OAuth app.
vercel connect create vercel --connection-method oauth --name baby-publish --data @/secure/path/credentials.json
vercel connect attach <returned-connector-uid-or-id>
```

Use the returned UID or canonical `scl_...` ID, not an assumed service name. Set `VERCEL_CONNECT_VERCEL_CONNECTOR` on the host. An API-key or MCP connector does not satisfy the delegated REST OAuth path and is rejected.

The deployed host uses its Vercel project OIDC identity. For local development, link the host and pull a development OIDC token; refresh it after expiration. Pull to a separate gitignored file and merge the identity settings so the local Supabase configuration in `.env.local` remains local:

```bash
vercel link
vercel env pull .env.vercel.local
```

External runtimes can use Connect's `vercelToken` option for app subjects or the access-token owner's own subject. **A platform operator's access token cannot impersonate arbitrary BabyLovable users.** This implementation requires host project OIDC for delegated owner subjects and does not substitute the host Sandbox `VERCEL_TOKEN`. Providing only `VERCEL_CONNECT_ACCESS_TOKEN` is insufficient for this user-delegated publishing flow.

Connect token requests and deployments have separate billing: Connect requests are billed to the host's Connect plan, while deployed app resources belong to the selected user Team. Check current pricing rather than hard-coding allowances into product behavior.

## User flow

1. Open **Backend → Publish → Connect Vercel**, authorize the OAuth client, and return to the app.
2. Select a Team from the provider-verified list and choose **Save Team**. The first Team is never selected automatically.
3. Choose **Publish to Vercel**. The host reserves a persistent job and starts a durable Workflow DevKit worker; the request does not wait for build completion.
4. The worker waits for Freestyle checkpoints, pins the actual `main` commit SHA, creates the app's Project if needed, exports source at that SHA, uploads files by SHA1, and creates a production deployment.
5. The panel follows `QUEUED → INITIALIZING → BUILDING → READY | ERROR`. A successful deployment displays the Project's production alias, not its unique deployment URL. Subsequent publications reuse the Project. Use its Vercel dashboard for deployment history and rollback.

Vercel authorization is bound to the authenticated Supabase owner once, using a server-derived owner subject. Team/Project bindings and publish jobs are scoped to the owner and session. The authorization cookie binds owner, session, provider, state, connector, and expiry; callback processing rechecks ownership and validates the token through the Teams API. Disconnecting removes this builder's account reference for all of that owner's apps and is blocked while any publication is active. It does not delete Vercel resources or revoke the grant at Vercel; provider-side revocation remains available there.

## Persistence and reconciliation

- `user_vercel_connections`: owner and connector reference only; no issued tokens.
- `vercel_publish_targets`: explicit Team, immutable Project binding, stable production URL.
- `vercel_publish_jobs`: source commit, mutation intent, deployment ID, workflow run, bounded worker lease, provider phase, safe error codes and redacted build output. Historical rows remain available to operators.
- `legacy_freestyle_publications`: preserved legacy deployment metadata and URL, with no new publishing operations.

Service-only SQL functions serialize target changes and job reservation. Repeated clicks return the active job. Worker leases fence persistence updates, and provider intent is recorded before either Project or Deployment creation. A replay checks the reserved Project name or deployment `meta.jobId` rather than resending an uncertain POST. Existing projects are not adopted during normal first creation.

Workflow polling uses exponential backoff from 2 seconds to 60 seconds, with a 45-minute automatic window. Status reads can restart an interrupted workflow start. After an uncertain timeout, the active slot remains reserved and **Check deployment status** starts another reconciliation of the same operation. A known failed deployment releases the slot. Never manually clear an uncertain slot until the remote operation has been inspected. An expired grant can be reauthorized while the worker is tracking a deployment.

The current documented API versions are `GET /v2/teams`, `POST /v11/projects`, `GET /v9/projects/{idOrName}`, `POST /v2/files`, `POST /v13/deployments`, `GET /v13/deployments/{id}`, and `GET /v7/deployments` for outcome reconciliation. These update the older version examples in the initial implementation request without changing its architecture.

## Source and environment behavior

The Freestyle Files API is read at the pinned commit. Binary bytes and Git blob hashes are verified. Export never executes generated app code, extracts archives, or follows symlinks. Unsafe paths, reported special files, tracked private `.env*` files, and oversized snapshots are refused; `.env.example` and `.env.template` are allowed. Internal build/package/platform trees are excluded. The Files API omits Unix modes; unidentified link-target blobs become ordinary file bytes, not executable links.

Limits are 10,000 entries, 25 MiB per file, 100 MiB decoded content, 150 MiB aggregate network response, and a 90-second source read budget. Uploads are deduplicated by SHA1, use four concurrent workers, and have a 60-second pass budget; failed content uploads can be safely repeated by a later job.

Connected backend keys are resolved only on the host immediately before deployment. Generated values are supplied as deployment-scoped `env` and `build.env`, following Vercel's official client. Unrelated Project environment variables remain inherited. On every publication, the worker diffs overlapping production keys: matching values are accepted; different or unreadable values block publication with an actionable conflict error. It never upserts or deletes the user's Project variables. Removing a connected service removes its deployment override on the next publication; independently configured Project values remain the user's responsibility.

Provider errors use fixed messages. Build logs are bounded and scrubbed for the provider token, resolved runtime/Project values, encoded variants and recognizable credential formats before persistence and display. Log scrubbing is not a general source-secret scanner. First publication success and preview HTTP readiness do not prove Auth, RLS, payments, or webhook behavior.

## Verification and live acceptance

```bash
npm test
BABY_TEST_LOCAL_POSTGRES=1 npm test -- src/lib/integrations/vercel-publish-store.test.ts
npm run lint
npm run build
```

Live acceptance requires the configured OAuth connector and an owner completing consent. The current development host has OIDC but, as of implementation verification, no Vercel connector is attached. Therefore the following checks remain required before rollout; mock transport tests do not establish these permissions:

- Complete a real Connect callback and list the owner's Teams.
- Select an authorized Team and publish an app with no backend dependencies. Verify Project creation and production Deployment creation in that Team, then fetch the stable public URL anonymously.
- Publish a second revision; verify another Deployment with the same production URL and inspect rollback in the dashboard.
- Link dedicated app Supabase/Stripe test services, republish, and verify production callbacks/webhook fulfillment against the stable domain.
- Exercise revoked authorization, interrupted submission, insufficient Project permissions, invalid builds and a conflicting Project env key. Confirm persisted state, reconnect/status-recovery UI and redacted errors/logs.
- Confirm the OAuth permissions granted by the user cover Teams, project creation, file upload, deployment creation/status, environment reads and domain lookup. The connector catalog alone does not prove those permissions.

References: [Vercel connector](https://vercel.com/connect/vercel), [Connect authentication](https://vercel.com/docs/connect/concepts/authentication), [OAuth API permissions](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions), [Vercel OpenAPI](https://openapi.vercel.sh/), [Vercel client deployment types](https://github.com/vercel/vercel/blob/main/packages/client/src/types.ts), [Create deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment).
