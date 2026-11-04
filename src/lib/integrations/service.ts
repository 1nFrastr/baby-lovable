import { randomBytes, randomUUID } from "node:crypto";

import { isDaytonaFreePlan } from "@/lib/features/daytona-free-plan";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSessionMeta } from "@/lib/session/store";

import { configuredSupabaseConnector, configuredStripeConnector, configuredVercelConnector, getAppConnectToken, startAppConnectAuthorization, verifyAppConnector, type AppConnectBinding, type ConnectProvider } from "./connect";
import { getVercelPublishProjection, startVercelPublication } from "./vercel-publish";
import { saveVercelConnection } from "./vercel-publish-store";
import { listVercelTeams } from "./vercel-api";
import { integrationFetch, supabaseHeaders } from "./http";
import { decryptSecretJson, encryptSecretJson, isIntegrationSecretsKeyConfigured } from "./secrets";
import {
  saveSupabaseConnectAccount,
  linkStripeKeys,
  linkSupabaseProject,
  readSessionIntegrations,
  unlinkStripe,
  unlinkSupabaseProject,
} from "./store";
import {
  getSupabaseProjectApiKeys,
  listSupabaseProjects,
  supabaseProjectUrl,
  supabaseManagementRequest,
  SupabaseManagementError,
  type SupabaseManagementProject,
} from "./supabase-management";
import {
  detectStripeMode,
  hintPublishableKey,
  toIntegrationsProjection,
  type SessionIntegrationsProjection,
} from "./types";

export { syncIntegrationEnvToWorkspace } from "./runtime-env";

import { IntegrationError } from "./errors";
export { IntegrationError } from "./errors";

function requireSecretsKey(): void {
  if (!isIntegrationSecretsKeyConfigured()) {
    throw new IntegrationError("Connections are temporarily unavailable. Please contact support.", 503);
  }
}

async function requireOwnedSession(sessionId: string, userId: string, idle = true) {
  const session = await getSessionMeta(sessionId, { userId });
  if (!session) throw new IntegrationError("App not found", 404);
  if (idle && ["pending", "running", "cancelling"].includes(session.runStatus)) {
    throw new IntegrationError("Wait for the current app changes to finish, then try again.", 409);
  }
  return session;
}

export async function getIntegrationsStatus(sessionId: string, userId: string): Promise<SessionIntegrationsProjection> {
  const record = await readSessionIntegrations(sessionId, false);
  if (record && record.userId !== userId) throw new IntegrationError("Forbidden", 403);
  const supabase = Boolean(configuredSupabaseConnector());
  const stripe = Boolean(configuredStripeConnector() || record?.stripeConnectConnector);
  const publication = await getVercelPublishProjection(sessionId, userId);
  return { ...toIntegrationsProjection(record, {
    secretsConfigured: isIntegrationSecretsKeyConfigured(),
    supabaseOauthConfigured: supabase,
    supabaseAccountConnected: Boolean(record?.supabaseConnectConnector),
  }), ...publication, connect: { supabase, stripe, vercel: Boolean(configuredVercelConnector()) } };
}

interface ConnectCookie {
  state: string;
  userId: string;
  sessionId: string;
  provider: ConnectProvider;
  binding: AppConnectBinding;
  expiresAt: number;
}

export async function startSessionConnection(input: {
  userId: string; sessionId: string; provider: ConnectProvider; origin: string;
}): Promise<{ authorizeUrl: string; cookieValue: string }> {
  requireSecretsKey();
  await requireOwnedSession(input.sessionId, input.userId);
  const record = await readSessionIntegrations(input.sessionId, false);
  if (input.provider !== "vercel" && (input.provider === "supabase" ? record?.supabaseStatus : record?.stripeStatus) === "linked") {
    throw new IntegrationError("Unlink this service before choosing another account.", 409);
  }
  const connector = input.provider === "supabase"
    ? configuredSupabaseConnector()
    : input.provider === "vercel" ? configuredVercelConnector() : record?.stripeConnectConnector || configuredStripeConnector();
  if (!connector) throw new IntegrationError("This service connection is not available yet. Please contact support.", 503);
  const binding: AppConnectBinding = { connector, subject: input.provider === "stripe" && record?.stripeConnectConnector ? record.stripeConnectSubject ?? "user" : "user", ...(input.provider === "vercel" ? { scope: "owner" as const } : {}) };
  await verifyAppConnector(binding, input.provider);
  const state = randomBytes(32).toString("base64url");
  const cookie: ConnectCookie = { ...input, binding, state, expiresAt: Date.now() + 600_000 };
  const callback = new URL("/api/integrations/connect/callback", input.origin);
  callback.searchParams.set("state", state);
  callback.searchParams.set("provider", input.provider);
  if (input.provider === "vercel") callback.searchParams.set("session", input.sessionId);
  // App-scoped managed Stripe grants are provisioned by an operator. Never send
  // ordinary users to a team-administration page to obtain a shared credential.
  const authorizeUrl = binding.subject === "app"
    ? callback.href
    : await startAppConnectAuthorization(binding, input.userId, input.sessionId, callback.href);
  return { authorizeUrl, cookieValue: encryptSecretJson(cookie) };
}

export async function completeSessionConnection(input: {
  state: string; cookieValue: string | null; userId: string; provider: ConnectProvider;
}): Promise<{ sessionId: string; provider: ConnectProvider; preview?: IntegrationMutationResult["preview"] }> {
  requireSecretsKey();
  let cookie: ConnectCookie;
  try {
    if (!input.cookieValue) throw new Error();
    cookie = decryptSecretJson<ConnectCookie>(input.cookieValue);
  } catch { throw new IntegrationError("This connection request has expired. Please connect again."); }
  if (cookie.state !== input.state || cookie.userId !== input.userId || cookie.provider !== input.provider || !Number.isFinite(cookie.expiresAt) || cookie.expiresAt <= Date.now()) {
    throw new IntegrationError("This connection request has expired. Please connect again.");
  }
  await requireOwnedSession(cookie.sessionId, input.userId);
  const existing = await readSessionIntegrations(cookie.sessionId, false);
  if (cookie.provider !== "vercel" && (cookie.provider === "supabase" ? existing?.supabaseStatus : existing?.stripeStatus) === "linked") {
    throw new IntegrationError("This app already has a connection. Unlink it before choosing another account.", 409);
  }
  await verifyAppConnector(cookie.binding, cookie.provider);
  // Callback parameters never contain provider credentials. Verify the grant
  // directly with Connect, including after consent was cancelled or revoked.
  const grant = await getAppConnectToken(cookie.binding, input.userId, cookie.sessionId, true);
  let preview: IntegrationMutationResult["preview"] | undefined;
  if (cookie.provider === "supabase") {
    await listSupabaseProjects(grant.token);
    await saveSupabaseConnectAccount(cookie.sessionId, input.userId, cookie.binding.connector);
  } else if (cookie.provider === "vercel") {
    if (cookie.binding.scope !== "owner" || cookie.binding.subject !== "user") throw new IntegrationError("Invalid Vercel account binding.", 400);
    await listVercelTeams(grant.token);
    await saveVercelConnection(input.userId, cookie.binding.connector);
  } else {
    const match = grant.token.match(/^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/);
    if (!match) throw new IntegrationError("Use a Stripe API connection for this app.", 400);
    const response = await integrationFetch("Stripe", "https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${grant.token}` } });
    const balance = await response.json() as { livemode: boolean };
    if (balance.livemode !== (match[1] === "live")) throw new IntegrationError("Stripe payment mode could not be verified.");
    const accountResponse = await integrationFetch("Stripe", "https://api.stripe.com/v1/account", { headers: { Authorization: `Bearer ${grant.token}` } });
    const account = await accountResponse.json() as { id?: string };
    if (!/^acct_[A-Za-z0-9]+$/.test(account.id ?? "")) throw new IntegrationError("Stripe account identity could not be verified.");
    await linkStripeKeys({ sessionId: cookie.sessionId, userId: input.userId,
      secrets: { publishableKey: "", secretKey: "" }, mode: match[1] as "test" | "live", publishableKeyHint: "Hosted Checkout",
      connectConnector: cookie.binding.connector, connectSubject: cookie.binding.subject, accountId: account.id });
    preview = (await activateIntegrationSettings(cookie.sessionId, input.userId)).preview;
  }
  return { sessionId: cookie.sessionId, provider: cookie.provider, ...(preview ? { preview } : {}) };
}

export async function listLinkedUserSupabaseProjects(userId: string, sessionId: string): Promise<SupabaseManagementProject[]> {
  await requireOwnedSession(sessionId, userId, false);
  const record = await readSessionIntegrations(sessionId, false);
  if (!record?.supabaseConnectConnector) throw new IntegrationError("Connect your Supabase account first.", 409);
  const grant = await getAppConnectToken({ connector: record.supabaseConnectConnector, subject: "user" }, userId, sessionId);
  return listSupabaseProjects(grant.token);
}

export async function listSupabaseProvisioningOrganizations(userId: string, sessionId: string) {
  await requireOwnedSession(sessionId, userId, false);
  const record = await readSessionIntegrations(sessionId, false);
  if (!record?.supabaseConnectConnector) throw new IntegrationError("Connect your Supabase account first.", 409);
  const grant = await getAppConnectToken({ connector: record.supabaseConnectConnector, subject: "user" }, userId, sessionId);
  return supabaseManagementRequest<{ slug: string; name: string }[]>(grant.token, "/organizations");
}

export async function provisionSessionSupabase(userId: string, sessionId: string, organizationSlug: string) {
  await requireOwnedSession(sessionId, userId);
  const record = await readSessionIntegrations(sessionId, false);
  if (record?.supabaseStatus === "linked") throw new IntegrationError("This app already has a Supabase project.", 409);
  if (!record?.supabaseConnectConnector) throw new IntegrationError("Connect your Supabase account first.", 409);
  const grant = await getAppConnectToken({ connector: record.supabaseConnectConnector, subject: "user" }, userId, sessionId);
  const organizations = await supabaseManagementRequest<{ slug: string }[]>(grant.token, "/organizations");
  if (!organizations.some((org) => org.slug === organizationSlug)) throw new IntegrationError("Choose an organization from your connected account.", 403);

  const admin = getSupabaseAdminClient();
  const id = randomUUID();
  const action = "create_supabase_project";
  const { error } = await admin.from("backend_operations").insert({
    id, session_id: sessionId, provider: "supabase", action, resource: organizationSlug, status: "running",
  });
  if (error && error.code !== "23505") throw new IntegrationError("Could not reserve project creation. Try again later.", 503);

  let projectRef: string | undefined;
  let operationId = id;
  if (error) {
    const { data, error: lookupError } = await admin.from("backend_operations").select("id,resource")
      .eq("session_id", sessionId).eq("action", action).neq("status", "failed").single();
    if (lookupError || !data) throw new IntegrationError("Could not check project creation. Try again later.", 503);
    if (data.resource !== organizationSlug) throw new IntegrationError("Select the original organization to resume project setup.", 409);
    operationId = data.id;
    const name = `baby-app-${operationId}`;
    const { projects } = await supabaseManagementRequest<{ projects: { ref: string; name: string; is_branch: boolean }[] }>(
      grant.token, `/organizations/${encodeURIComponent(organizationSlug)}/projects?search=${encodeURIComponent(name)}&limit=2`,
    );
    const matches = projects.filter((project) => project.name === name && !project.is_branch);
    if (matches.length === 1) projectRef = matches[0].ref;
  } else {
    try {
      const created = await supabaseManagementRequest<{ id: string; ref?: string }>(grant.token, "/projects", {
        method: "POST",
        body: { organization_slug: organizationSlug, region: "us-east-1", name: `baby-app-${id}`, db_pass: randomBytes(32).toString("base64url") },
      });
      projectRef = created.ref ?? created.id;
    } catch (cause) {
      const status = cause instanceof SupabaseManagementError ? cause.status : null;
      if (status && [400, 401, 403, 422, 429].includes(status)) {
        await admin.from("backend_operations").update({ status: "failed", error_code: `provider_${status}`, finished_at: new Date().toISOString() }).eq("id", id);
        throw new IntegrationError(
          status === 401 || status === 403
            ? "Supabase denied project creation. Check your organization role and reconnect with Projects write access."
            : "Supabase declined project creation. Check your project quota and try again.",
          status,
          status === 401 || status === 403 ? "supabase_provision_permission" : status === 429 ? undefined : "supabase_provision_declined",
        );
      }
      // A lost response does not prove the provider failed to create a project.
    }
  }
  if (!projectRef || !/^[a-z0-9]+$/.test(projectRef)) return null;
  const project = (await listSupabaseProjects(grant.token)).find((item) => item.ref === projectRef);
  if (project?.status !== "ACTIVE_HEALTHY") return null;
  const latest = await readSessionIntegrations(sessionId, false);
  if (latest?.supabaseStatus === "linked") throw new IntegrationError("This app already has a Supabase project.", 409);
  const result = await linkSessionSupabaseViaConnect({ userId, sessionId, projectRef, expectedConnector: record.supabaseConnectConnector });
  const { error: auditError } = await admin.from("backend_operations")
    .update({ status: "succeeded", finished_at: new Date().toISOString() }).eq("id", operationId);
  if (auditError) console.warn("[integrations] Could not record Supabase provisioning completion", operationId);
  return result;
}

export interface IntegrationMutationResult extends SessionIntegrationsProjection {
  preview: { status: "ready" | "error"; error: string | null };
}

/** Saving and activating are distinct outcomes: a failed restart must stay visible. */
export async function activateIntegrationSettings(sessionId: string, userId: string): Promise<IntegrationMutationResult> {
  let preview: IntegrationMutationResult["preview"];
  try {
    const { runCheckPreviewProbe, stopAppServer } = await import("@/lib/sandbox/preview");
    // Stop the old process before touching credentials. A failed env sync must
    // never leave a ready process silently serving the previous connection.
    await stopAppServer(sessionId);
    const result = await runCheckPreviewProbe(sessionId, { restart: true });
    preview = result.ok
      ? { status: "ready", error: null }
      : { status: "error", error: "Settings saved. Preview is still starting or needs attention. Retry the preview to apply them." };
  } catch {
    console.warn(`[integrations] session=${sessionId} event=preview_activation_failed`);
    preview = { status: "error", error: "Settings saved, but the preview could not restart. Retry the preview before continuing." };
  }
  return { ...await getIntegrationsStatus(sessionId, userId), preview };
}

export async function linkSessionSupabaseViaConnect(input: {
  sessionId: string; userId: string; projectRef: string; expectedConnector?: string;
}): Promise<IntegrationMutationResult> {
  requireSecretsKey();
  await requireOwnedSession(input.sessionId, input.userId);
  const record = await readSessionIntegrations(input.sessionId, false);
  if (!record?.supabaseConnectConnector) throw new IntegrationError("Connect your Supabase account first.", 409);
  if (input.expectedConnector && input.expectedConnector !== record.supabaseConnectConnector) throw new IntegrationError("The Supabase connection changed during setup.", 409);
  const { token } = await getAppConnectToken({ connector: record.supabaseConnectConnector, subject: "user" }, input.userId, input.sessionId);
  const projects = await listSupabaseProjects(token);
  const project = projects.find((p) => p.ref === input.projectRef);
  if (!project) throw new IntegrationError("Project not found in your Supabase account", 404);
  if (project.status !== "ACTIVE_HEALTHY") throw new IntegrationError("This project is not ready yet. Resume it in Supabase and try again.", 409);
  // Probe key permission now; project runtime keys are fetched again at use time.
  await getSupabaseProjectApiKeys(token, project.ref);
  const linked = await linkSupabaseProject({ sessionId: input.sessionId, userId: input.userId, projectRef: input.projectRef, projectName: project.name, projectUrl: supabaseProjectUrl(project.ref), linkMethod: "connect", secrets: null, connectConnector: record.supabaseConnectConnector, ...(input.expectedConnector ? { onlyIfUnlinked: true } : {}) });
  if (input.expectedConnector && !linked) throw new IntegrationError("The Supabase connection changed during setup.", 409);
  return activateIntegrationSettings(input.sessionId, input.userId);
}

export function normalizeSupabaseUrl(value: string): { url: string; projectRef: string } {
  try {
    const url = new URL(value.trim());
    const match = url.hostname.match(/^([a-z0-9]{1,63})\.supabase\.co$/);
    if (!match || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") throw new Error();
    return { url: url.origin, projectRef: match[1] };
  } catch { throw new IntegrationError("Use the project URL shown in your Supabase project settings (https://your-project.supabase.co)."); }
}

export async function linkSessionSupabaseManual(input: {
  sessionId: string; userId: string; projectUrl: string; anonKey: string; serviceRoleKey: string; projectName?: string;
}): Promise<IntegrationMutationResult> {
  requireSecretsKey();
  await requireOwnedSession(input.sessionId, input.userId);
  const { url, projectRef } = normalizeSupabaseUrl(input.projectUrl);
  const secrets = { anonKey: input.anonKey.trim(), serviceRoleKey: input.serviceRoleKey.trim() };
  if (Object.values(secrets).some((key) => !key || /[\s$"\\]/.test(key))) throw new IntegrationError("Copy the complete project keys from Supabase settings.");
  await integrationFetch("Supabase", `${url}/auth/v1/settings`, { headers: { apikey: secrets.anonKey } });
  await integrationFetch("Supabase", `${url}/auth/v1/admin/users?page=1&per_page=1`, { headers: supabaseHeaders(secrets.anonKey, secrets.serviceRoleKey) });
  await linkSupabaseProject({ ...input, projectRef, projectName: input.projectName?.trim() || projectRef, projectUrl: url, linkMethod: "manual", secrets });
  return activateIntegrationSettings(input.sessionId, input.userId);
}

export async function unlinkSessionSupabase(sessionId: string, userId: string): Promise<IntegrationMutationResult> {
  await requireOwnedSession(sessionId, userId);
  await unlinkSupabaseProject(sessionId, userId);
  return activateIntegrationSettings(sessionId, userId);
}

export function validateStripeKeys(publishableKey: string, secretKey: string, webhookSecret?: string) {
  const publicMatch = publishableKey.match(/^pk_(test|live)_[A-Za-z0-9]+$/);
  const secretMatch = secretKey.match(/^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/);
  if (!publicMatch || !secretMatch || publicMatch[1] !== secretMatch[1]) throw new IntegrationError("Use Stripe public and secret keys from the same account and the same test or live mode.");
  if (webhookSecret && !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) throw new IntegrationError("Copy the complete payment notification signing secret from Stripe.");
}

export async function linkSessionStripe(input: {
  sessionId: string; userId: string; publishableKey: string; secretKey: string; webhookSecret?: string;
}): Promise<IntegrationMutationResult> {
  requireSecretsKey();
  await requireOwnedSession(input.sessionId, input.userId);
  const publishableKey = input.publishableKey.trim();
  const secretKey = input.secretKey.trim();
  const webhookSecret = input.webhookSecret?.trim() || undefined;
  validateStripeKeys(publishableKey, secretKey, webhookSecret);
  const check = await integrationFetch("Stripe", "https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${secretKey}` } });
  const balance = await check.json() as { livemode: boolean };
  if (balance.livemode !== (detectStripeMode(publishableKey) === "live")) throw new IntegrationError("These Stripe keys belong to different modes.");
  await linkStripeKeys({ sessionId: input.sessionId, userId: input.userId, secrets: { publishableKey, secretKey, webhookSecret }, mode: detectStripeMode(publishableKey), publishableKeyHint: hintPublishableKey(publishableKey) });
  return activateIntegrationSettings(input.sessionId, input.userId);
}

export async function unlinkSessionStripe(sessionId: string, userId: string): Promise<IntegrationMutationResult> {
  await requireOwnedSession(sessionId, userId);
  await unlinkStripe(sessionId, userId);
  return activateIntegrationSettings(sessionId, userId);
}

export async function refreshSessionConnections(sessionId: string, userId: string): Promise<IntegrationMutationResult> {
  await requireOwnedSession(sessionId, userId);
  return activateIntegrationSettings(sessionId, userId);
}

export async function publishSession(input: { sessionId: string; userId: string }): Promise<SessionIntegrationsProjection> {
  const session = await requireOwnedSession(input.sessionId, input.userId);
  if (isDaytonaFreePlan(session.sandboxMode)) throw new IntegrationError("Publishing is unavailable for this preview plan.", 403);
  await startVercelPublication(input.sessionId, input.userId);
  return getIntegrationsStatus(input.sessionId, input.userId);
}
