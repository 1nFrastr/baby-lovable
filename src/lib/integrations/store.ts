import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import { decryptSecretJson, encryptSecretJson } from "./secrets";
import type {
  StoredDeployProvider,
  DeployStatus,
  SessionIntegrationsRecord,
  StripeLinkStatus,
  StripeMode,
  StripeSecrets,
  SupabaseLinkMethod,
  SupabaseLinkStatus,
  SupabaseProjectSecrets,
} from "./types";

interface IntegrationRow {
  session_id: string;
  user_id: string;
  supabase_status: SupabaseLinkStatus;
  supabase_project_ref: string | null;
  supabase_project_name: string | null;
  supabase_project_url: string | null;
  supabase_link_method: SupabaseLinkMethod | null;
  supabase_connect_connector: string | null;
  stripe_connect_connector: string | null;
  stripe_connect_subject: "user" | "app" | null;
  stripe_account_id: string | null;
  supabase_secrets_ciphertext: string | null;
  supabase_error: string | null;
  stripe_status: StripeLinkStatus;
  stripe_mode: StripeMode | null;
  stripe_publishable_key_hint: string | null;
  stripe_secrets_ciphertext: string | null;
  stripe_error: string | null;
  deploy_status: DeployStatus;
  deploy_provider: StoredDeployProvider | null;
  deploy_id: string | null;
  deploy_url: string | null;
  deploy_error: string | null;
  deploy_updated_at: string | null;
  updated_at: string;
}

function fromRow(
  row: IntegrationRow,
  decrypt = true,
): SessionIntegrationsRecord {
  const supabaseSecrets = decrypt && row.supabase_secrets_ciphertext
    ? decryptSecretJson<SupabaseProjectSecrets>(row.supabase_secrets_ciphertext)
    : null;
  const stripeSecrets = decrypt && row.stripe_secrets_ciphertext
    ? decryptSecretJson<StripeSecrets>(row.stripe_secrets_ciphertext)
    : null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    supabaseStatus: row.supabase_status,
    supabaseProjectRef: row.supabase_project_ref,
    supabaseProjectName: row.supabase_project_name,
    supabaseProjectUrl: row.supabase_project_url,
    supabaseLinkMethod: row.supabase_link_method,
    supabaseConnectConnector: row.supabase_connect_connector ?? null,
    stripeConnectConnector: row.stripe_connect_connector ?? null,
    stripeConnectSubject: row.stripe_connect_subject ?? null,
    stripeAccountId: row.stripe_account_id ?? null,
    supabaseSecrets,
    supabaseError: row.supabase_error,
    stripeStatus: row.stripe_status,
    stripeMode: row.stripe_mode,
    stripePublishableKeyHint: row.stripe_publishable_key_hint,
    stripeSecrets,
    stripeError: row.stripe_error,
    deployStatus: row.deploy_status,
    deployProvider: row.deploy_provider,
    deployId: row.deploy_id,
    deployUrl: row.deploy_url,
    deployError: row.deploy_error,
    deployUpdatedAt: row.deploy_updated_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLS =
  "session_id, user_id, supabase_status, supabase_project_ref, supabase_project_name, supabase_project_url, supabase_link_method, supabase_connect_connector, stripe_connect_connector, stripe_connect_subject, stripe_account_id, supabase_secrets_ciphertext, supabase_error, stripe_status, stripe_mode, stripe_publishable_key_hint, stripe_secrets_ciphertext, stripe_error, deploy_status, deploy_provider, deploy_id, deploy_url, deploy_error, deploy_updated_at, updated_at";

const METADATA_SELECT_COLS = SELECT_COLS.split(", ")
  .filter((column) => !column.endsWith("_ciphertext"))
  .join(", ");

export class IntegrationStorageNotReadyError extends Error {
  constructor() {
    super("Integration storage is unavailable. Apply the integration migration before configuring integrations.");
    this.name = "IntegrationStorageNotReadyError";
  }
}

/** Pass false for status/UI reads: ciphertext is neither selected nor decrypted. */
export async function readSessionIntegrations(
  sessionId: string,
  decrypt = true,
): Promise<SessionIntegrationsRecord | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_integrations")
    .select(decrypt ? SELECT_COLS : METADATA_SELECT_COLS)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") {
      throw new IntegrationStorageNotReadyError();
    }
    throw new Error("Failed to read session integrations.");
  }
  return data ? fromRow(data as unknown as IntegrationRow, decrypt) : null;
}

async function upsertRow(
  sessionId: string,
  userId: string,
  patch: Record<string, unknown>,
): Promise<SessionIntegrationsRecord> {
  const supabase = getSupabaseAdminClient();
  const updatedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("session_integrations")
    .upsert(
      {
        session_id: sessionId,
        user_id: userId,
        ...patch,
        updated_at: updatedAt,
      },
      { onConflict: "session_id" },
    )
    .select(SELECT_COLS)
    .single();
  if (error) {
    throw new Error(`Failed to write session integrations: ${error.message}`);
  }
  return fromRow(data as IntegrationRow);
}

export async function linkSupabaseProject(input: {
  sessionId: string;
  userId: string;
  projectRef: string;
  projectName: string;
  projectUrl: string;
  linkMethod: SupabaseLinkMethod;
  secrets: SupabaseProjectSecrets | null;
  connectConnector?: string;
  onlyIfUnlinked?: boolean;
}): Promise<SessionIntegrationsRecord | null> {
  const changes = {
    supabase_status: "linked",
    supabase_project_ref: input.projectRef,
    supabase_project_name: input.projectName,
    supabase_project_url: input.projectUrl.replace(/\/$/, ""),
    supabase_link_method: input.linkMethod,
    supabase_connect_connector: input.connectConnector ?? null,
    supabase_secrets_ciphertext: input.linkMethod !== "connect" && input.secrets ? encryptSecretJson(input.secrets) : null,
    supabase_error: null,
  };
  if (input.onlyIfUnlinked) {
    const { data, error } = await getSupabaseAdminClient().from("session_integrations")
      .update({ ...changes, updated_at: new Date().toISOString() }).eq("session_id", input.sessionId).eq("user_id", input.userId)
      .eq("supabase_connect_connector", input.connectConnector!)
      .neq("supabase_status", "linked").select(SELECT_COLS).maybeSingle();
    if (error) throw new Error("Could not save the provisioned Supabase project.");
    if (!data) return null;
    return fromRow(data as IntegrationRow);
  }
  return upsertRow(input.sessionId, input.userId, changes);
}

export async function saveSupabaseConnectAccount(sessionId: string, userId: string, connector: string) {
  return upsertRow(sessionId, userId, { supabase_connect_connector: connector });
}

/** Operator-only assignment. A generated app may never select arbitrary team connectors. */
export async function assignStripeConnectApp(sessionId: string, userId: string, connector: string) {
  if (!/^scl_[A-Za-z0-9]+$/.test(connector)) throw new Error("Managed Stripe assignments require a canonical connector ID.");
  return upsertRow(sessionId, userId, {
    stripe_connect_connector: connector,
    stripe_connect_subject: "app",
    stripe_status: "disconnected",
    stripe_secrets_ciphertext: null,
    stripe_mode: null,
    stripe_account_id: null,
    stripe_publishable_key_hint: null,
    stripe_error: null,
  });
}

export async function unlinkSupabaseProject(
  sessionId: string,
  userId: string,
): Promise<SessionIntegrationsRecord> {
  return upsertRow(sessionId, userId, {
    supabase_status: "disconnected",
    supabase_project_ref: null,
    supabase_project_name: null,
    supabase_project_url: null,
    supabase_link_method: null,
    supabase_connect_connector: null,
    supabase_secrets_ciphertext: null,
    supabase_error: null,
  });
}

export async function setSupabaseIntegrationError(
  sessionId: string,
  userId: string,
  message: string,
): Promise<SessionIntegrationsRecord> {
  return upsertRow(sessionId, userId, {
    supabase_status: "error",
    supabase_error: message.slice(0, 500),
  });
}

export async function linkStripeKeys(input: {
  sessionId: string;
  userId: string;
  secrets: StripeSecrets;
  mode: StripeMode;
  publishableKeyHint: string;
  connectConnector?: string;
  connectSubject?: "user" | "app";
  accountId?: string;
}): Promise<SessionIntegrationsRecord> {
  return upsertRow(input.sessionId, input.userId, {
    stripe_status: "linked",
    stripe_connect_connector: input.connectConnector ?? null,
    stripe_connect_subject: input.connectSubject ?? null,
    stripe_account_id: input.accountId ?? null,
    stripe_mode: input.mode,
    stripe_publishable_key_hint: input.publishableKeyHint,
    stripe_secrets_ciphertext: encryptSecretJson(input.connectConnector ? { ...input.secrets, secretKey: "" } : input.secrets),
    stripe_error: null,
  });
}

export async function unlinkStripe(
  sessionId: string,
  userId: string,
): Promise<SessionIntegrationsRecord> {
  return upsertRow(sessionId, userId, {
    stripe_status: "disconnected",
    stripe_mode: null,
    stripe_account_id: null,
    stripe_publishable_key_hint: null,
    stripe_secrets_ciphertext: null,
    stripe_error: null,
  });
}
