import { getAppConnectToken } from "./connect";
import { IntegrationError } from "./errors";
import { integrationFetch } from "./http";
import { readSessionIntegrations } from "./store";
import { getSupabaseProjectApiKeys } from "./supabase-management";
import type { SessionIntegrationsRecord } from "./types";

export async function getSupabaseManagementToken(record: SessionIntegrationsRecord): Promise<string> {
  if (!record.supabaseConnectConnector || record.supabaseLinkMethod !== "connect") {
    throw new IntegrationError("Reconnect your Supabase account using the app's Backend panel to enable project administration.", 409);
  }
  const response = await getAppConnectToken({ connector: record.supabaseConnectConnector, subject: "user" }, record.userId, record.sessionId, true);
  return response.token;
}

/** Resolve at the moment of use. Connect credentials are never written to our DB. */
export async function resolveIntegrationCredentials(record: SessionIntegrationsRecord, provider?: "supabase" | "stripe"): Promise<SessionIntegrationsRecord> {
  const resolved = { ...record };
  if (provider !== "stripe" && record.supabaseStatus === "linked" && record.supabaseLinkMethod === "connect") {
    if (!record.supabaseProjectRef) throw new IntegrationError("Choose a Supabase project for this app.", 409);
    const token = await getSupabaseManagementToken(record);
    resolved.supabaseSecrets = await getSupabaseProjectApiKeys(token, record.supabaseProjectRef);
  }
  if (provider !== "supabase" && record.stripeStatus === "linked" && record.stripeConnectConnector) {
    if (!record.stripeSecrets || !record.stripeConnectSubject) throw new IntegrationError("Reconnect Stripe for this app.", 409);
    const response = await getAppConnectToken({ connector: record.stripeConnectConnector, subject: record.stripeConnectSubject }, record.userId, record.sessionId, true);
    const match = response.token.match(/^(?:rk|sk)_(test|live)_[A-Za-z0-9]+$/);
    if (!match || match[1] !== record.stripeMode) throw new IntegrationError("The Stripe connection changed payment mode. Reconnect it before continuing.", 409, "stripe_binding_changed");
    if (!record.stripeAccountId) throw new IntegrationError("Reconnect Stripe to verify this app's payment account.", 409);
    const accountResponse = await integrationFetch("Stripe", "https://api.stripe.com/v1/account", { headers: { Authorization: `Bearer ${response.token}` } });
    const account = await accountResponse.json() as { id?: string };
    if (account.id !== record.stripeAccountId) throw new IntegrationError("The Stripe connection changed accounts. Reconnect it before continuing.", 409, "stripe_binding_changed");
    resolved.stripeSecrets = { ...record.stripeSecrets, secretKey: response.token };
  }
  return resolved;
}

export async function readRuntimeIntegrations(sessionId: string) {
  const record = await readSessionIntegrations(sessionId);
  return record ? resolveIntegrationCredentials(record) : null;
}
