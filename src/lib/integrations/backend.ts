import { createHash, randomUUID } from "node:crypto";

import { getSessionMeta } from "@/lib/session/store";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import { backendInputSchema, type BackendInput } from "./backend-schema";
import { integrationFetch, supabaseHeaders } from "./http";
import { buildAppMigration, INSPECT_APP_SCHEMA } from "./migrations";
import { getSupabaseManagementToken, resolveIntegrationCredentials } from "./credentials";
import { activateIntegrationSettings, getIntegrationsStatus, IntegrationError } from "./service";
import { linkStripeKeys, readSessionIntegrations } from "./store";
import { supabaseManagementRequest } from "./supabase-management";
import { hintPublishableKey, type SessionIntegrationsRecord } from "./types";

function projectConnection(record: SessionIntegrationsRecord | null) {
  if (record?.supabaseStatus !== "linked" || !record.supabaseProjectRef || !record.supabaseProjectUrl) {
    throw new IntegrationError("Connect Supabase in your app's Backend panel first.", 409);
  }
  return record;
}

async function managementConnection(record: SessionIntegrationsRecord | null) {
  const linked = projectConnection(record);
  return { token: await getSupabaseManagementToken(linked), ref: linked.supabaseProjectRef! };
}

export function trustedAppOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new IntegrationError("A secure app URL is required.");
  return url.origin;
}

async function executeBackend(input: BackendInput, sessionId: string, userId: string) {
  if (input.action === "status") {
    const status = await getIntegrationsStatus(sessionId, userId);
    return { ...status, capabilities: {
      databaseManagement: status.supabase.status === "linked" && status.supabase.linkMethod === "connect",
      authConfiguration: status.supabase.status === "linked" && status.supabase.linkMethod === "connect",
      functionDeployment: status.supabase.status === "linked" && status.supabase.linkMethod === "connect",
      storageManagement: status.supabase.status === "linked",
      paymentsConnected: status.stripe.status === "linked",
      note: "Connected services do not prove that app authorization, policies or payment fulfillment work. Verify each requested flow.",
    } };
  }
  const record = await readSessionIntegrations(sessionId);
  switch (input.action) {
    case "inspect_schema": {
      const { token, ref } = await managementConnection(record);
      const schema = await supabaseManagementRequest(token, `/projects/${ref}/database/query`, { method: "POST", body: { query: INSPECT_APP_SCHEMA, read_only: true } });
      return { schema };
    }
    case "apply_migration": {
      const { token, ref } = await managementConnection(record);
      const { query, digest } = buildAppMigration(input.name, input.sql);
      await supabaseManagementRequest(token, `/projects/${ref}/database/query`, { method: "POST", body: { query } });
      return { migration: input.name, digest, message: "Migration committed or already applied with identical content. Public tables require row level security; verify policies separately." };
    }
    case "configure_auth": {
      const { token, ref } = await managementConnection(record);
      const { getPreviewUrlStatus } = await import("@/lib/sandbox/preview");
      const preview = await getPreviewUrlStatus(sessionId);
      const origins = [
        ...(preview.status === "ready" ? [trustedAppOrigin(preview.url)] : []),
        ...(record?.deployUrl ? [trustedAppOrigin(record.deployUrl)] : []),
      ];
      if (!origins.length) throw new IntegrationError("Start the preview before setting up sign-in.", 409);
      const config = await supabaseManagementRequest<{ site_url?: string; uri_allow_list?: string }>(token, `/projects/${ref}/config/auth`);
      const redirects = [...new Set([...(config.uri_allow_list ?? "").split(",").filter(Boolean), ...origins.map((origin) => `${origin}/auth/callback`)])];
      await supabaseManagementRequest(token, `/projects/${ref}/config/auth`, { method: "PATCH", body: { uri_allow_list: redirects.join(",") } });
      return { callbackUrls: origins.map((origin) => `${origin}/auth/callback`), message: "Allowed callback URLs updated. Existing site URL, email verification and login providers were preserved. Pass redirectTo explicitly in the app." };
    }
    case "create_bucket": {
      const connection = await resolveIntegrationCredentials(projectConnection(record), "supabase");
      if (!connection.supabaseSecrets) throw new IntegrationError("Reconnect Supabase for this app.", 409);
      const url = connection.supabaseProjectUrl!;
      const keys = connection.supabaseSecrets!;
      const headers = { ...supabaseHeaders(keys.anonKey, keys.serviceRoleKey), "Content-Type": "application/json" };
      // Read before create and compare on conflict: never silently turn private files public.
      let existing: { public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null } | null = null;
      const { IntegrationProviderError } = await import("./http");
      try {
        const response = await integrationFetch("Supabase", `${url}/storage/v1/bucket/${input.name}`, { headers });
        existing = await response.json();
      } catch (error) {
        if (!(error instanceof IntegrationProviderError) || error.status !== 404) throw error;
      }
      if (existing) {
        const sameTypes = JSON.stringify([...(existing.allowed_mime_types ?? [])].sort()) === JSON.stringify([...input.allowedMimeTypes].sort());
        if (existing.public !== input.public || existing.file_size_limit !== input.fileSizeLimit || !sameTypes) throw new IntegrationError("This file space already exists with different settings. Choose a new name; existing access settings are preserved.", 409);
      } else {
        await integrationFetch("Supabase", `${url}/storage/v1/bucket`, { method: "POST", headers, body: JSON.stringify({ id: input.name, name: input.name, public: input.public, file_size_limit: input.fileSizeLimit, allowed_mime_types: input.allowedMimeTypes }) });
      }
      return { bucket: input.name, public: input.public, message: "File space is configured. Add and verify storage.objects policies before uploads; signed downloads require authorization." };
    }
    case "deploy_function": {
      const { token, ref } = await managementConnection(record);
      const form = new FormData();
      form.set("metadata", JSON.stringify({ name: input.name, entrypoint_path: "index.ts", verify_jwt: true }));
      form.set("file", new Blob([input.source], { type: "application/typescript" }), "index.ts");
      await supabaseManagementRequest(token, `/projects/${ref}/functions/deploy?slug=${encodeURIComponent(input.name)}`, { method: "POST", body: form });
      return { function: input.name, url: `${record!.supabaseProjectUrl}/functions/v1/${input.name}`, verifyJWT: true, message: "Function deployed with JWT verification. Validate caller identity and authorization in the handler as well." };
    }
    case "configure_stripe_webhook": {
      if (record?.stripeStatus !== "linked" || !record.stripeSecrets) throw new IntegrationError("Connect Stripe in your app's Backend panel first.", 409);
      if (!record.deployUrl || record.deployStatus !== "live") throw new IntegrationError("Publish the app before connecting payment notifications to its permanent address.", 409);
      const endpointUrl = `${trustedAppOrigin(record.deployUrl)}/api/stripe/webhook`;
      const secret = (await resolveIntegrationCredentials(record, "stripe")).stripeSecrets!;
      const authorization = { Authorization: `Bearer ${secret.secretKey}` };
      const list = await integrationFetch("Stripe", "https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers: authorization });
      const endpoints = await list.json() as { data: { id: string; url: string; status: string; metadata?: Record<string, string> }[]; has_more: boolean };
      const owned = endpoints.data.find((endpoint) => endpoint.url === endpointUrl && endpoint.metadata?.baby_session_id === sessionId && endpoint.status === "enabled");
      if (owned && secret.webhookSecret && secret.webhookEndpointId === owned.id && secret.webhookEndpointUrl === endpointUrl) return { endpoint: endpointUrl, message: "Payment notification endpoint is already connected. Verify fulfillment with Stripe test events." };
      if (owned || endpoints.has_more) throw new IntegrationError("Payment notifications need reconciliation in Stripe before creating another endpoint. Contact support.", 409);
      const body = new URLSearchParams({ url: endpointUrl, "metadata[baby_session_id]": sessionId });
      for (const event of ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]) body.append("enabled_events[]", event);
      const idempotencyKey = createHash("sha256").update(`${sessionId}:${endpointUrl}:${record.stripeConnectConnector ?? secret.secretKey}`).digest("hex");
      const response = await integrationFetch("Stripe", "https://api.stripe.com/v1/webhook_endpoints", { method: "POST", headers: { ...authorization, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `baby-webhook-${idempotencyKey}` }, body });
      const endpoint = await response.json() as { id: string; secret?: string };
      if (!endpoint.secret || !endpoint.id) throw new IntegrationError("Stripe did not return notification signing details. Contact support.", 502);
      await linkStripeKeys({ sessionId, userId, secrets: { ...record.stripeSecrets, webhookSecret: endpoint.secret, webhookEndpointId: endpoint.id, webhookEndpointUrl: endpointUrl }, mode: record.stripeMode!, publishableKeyHint: secret.publishableKey ? hintPublishableKey(secret.publishableKey) : "Hosted Checkout", connectConnector: record.stripeConnectConnector ?? undefined, connectSubject: record.stripeConnectSubject ?? undefined, accountId: record.stripeAccountId ?? undefined });
      const activation = await activateIntegrationSettings(sessionId, userId);
      return { endpoint: endpointUrl, redeployRequired: true, preview: activation.preview, message: "Payment notification signing secret saved securely. Publish again to activate it in production, then verify a test payment and duplicate event delivery." };
    }
  }
}

/** Only metadata is persisted; all provider credentials stay outside model context. */
export async function runBackendOperation(rawInput: BackendInput, sessionId: string, turnId?: string) {
  const input = backendInputSchema.parse(rawInput);
  const session = await getSessionMeta(sessionId);
  if (!session?.userId) throw new IntegrationError("An app owner is required for backend operations.", 403);
  if (turnId && session.activeTurnId !== turnId) throw new IntegrationError("This app change was superseded.", 409);
  const id = randomUUID();
  const provider = input.action === "configure_stripe_webhook" ? "stripe" : input.action === "status" ? "platform" : "supabase";
  const resource = "name" in input ? input.name : null;
  const digest = "sql" in input || "source" in input ? createHash("sha256").update("sql" in input ? input.sql : input.source).digest("hex") : null;
  const admin = getSupabaseAdminClient();
  const { error: insertError } = await admin.from("backend_operations").insert({ id, session_id: sessionId, provider, action: input.action, resource, content_digest: digest, status: "running" });
  if (insertError) throw new IntegrationError("Backend operation history is unavailable. Please try again later.", 503);
  const started = Date.now();
  try {
    const result = await executeBackend(input, sessionId, session.userId);
    const { error } = await admin.from("backend_operations").update({ status: "succeeded", finished_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new IntegrationError("The provider operation completed, but its history could not be updated. Check the resource before retrying.", 503);
    console.info(`[backend] session=${sessionId} operation=${id} action=${input.action} status=succeeded duration_ms=${Date.now() - started}`);
    return { ok: true as const, operationId: id, ...result };
  } catch (error) {
    const code = error instanceof IntegrationError ? error.code ?? `integration_${error.status}` : "provider_failed";
    await admin.from("backend_operations").update({ status: "failed", error_code: code, finished_at: new Date().toISOString() }).eq("id", id);
    console.warn(`[backend] session=${sessionId} operation=${id} action=${input.action} status=failed code=${code} duration_ms=${Date.now() - started}`);
    const failure = error instanceof IntegrationError ? error : new IntegrationError("The backend provider could not complete this operation. Check connection permissions and the provider's logs before retrying. No provider response or application data is included here.", 502);
    failure.operationId = id;
    throw failure;
  }
}
