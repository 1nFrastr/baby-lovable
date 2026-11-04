export type SupabaseLinkStatus =
  | "disconnected"
  | "connecting"
  | "linked"
  | "error";

export type SupabaseLinkMethod = "connect" | "oauth" | "manual";

export type StripeLinkStatus = "disconnected" | "linked" | "error";

export type StripeMode = "test" | "live";

export type DeployStatus = "idle" | "deploying" | "live" | "error";

export type DeployProvider = "vercel";
/** Freestyle is accepted only when displaying historical publications. */
export type StoredDeployProvider = DeployProvider | "freestyle";

export interface SupabaseProjectSecrets {
  anonKey: string;
  serviceRoleKey: string;
}

export interface StripeSecrets {
  publishableKey: string;
  secretKey: string;
  webhookSecret?: string;
  /** Bind the signing secret to the endpoint that returned it. */
  webhookEndpointId?: string;
  webhookEndpointUrl?: string;
}

export interface SessionIntegrationsRecord {
  sessionId: string;
  userId: string;

  supabaseStatus: SupabaseLinkStatus;
  supabaseProjectRef: string | null;
  supabaseProjectName: string | null;
  supabaseProjectUrl: string | null;
  supabaseLinkMethod: SupabaseLinkMethod | null;
  supabaseConnectConnector?: string | null;
  /** Present only when decrypting for trusted server use — never API/UI. */
  supabaseSecrets: SupabaseProjectSecrets | null;
  supabaseError: string | null;

  stripeStatus: StripeLinkStatus;
  stripeMode: StripeMode | null;
  stripePublishableKeyHint: string | null;
  stripeSecrets: StripeSecrets | null;
  stripeConnectConnector?: string | null;
  stripeConnectSubject?: "user" | "app" | null;
  stripeAccountId?: string | null;
  stripeError: string | null;

  deployStatus: DeployStatus;
  deployProvider: StoredDeployProvider | null;
  deployId: string | null;
  deployUrl: string | null;
  deployError: string | null;
  deployUpdatedAt: string | null;

  updatedAt: string;
}

/** Safe projection for UI / runtime (no secret material). */
export interface SessionIntegrationsProjection {
  supabase: {
    status: SupabaseLinkStatus;
    projectRef: string | null;
    projectName: string | null;
    projectUrl: string | null;
    linkMethod: SupabaseLinkMethod | null;
    error: string | null;
  };
  stripe: {
    status: StripeLinkStatus;
    mode: StripeMode | null;
    publishableKeyHint: string | null;
    error: string | null;
  };
  deploy: {
    status: DeployStatus;
    provider: StoredDeployProvider | null;
    deploymentId: string | null;
    url: string | null;
    error: string | null;
    updatedAt: string | null;
    phase?: string | null;
    logs?: string | null;
    sourceSha?: string | null;
    jobId?: string | null;
    errorCode?: string | null;
  };
  vercel?: {
    connected: boolean;
    teamId: string | null;
    teamName: string | null;
    projectId: string | null;
    projectName: string | null;
    dashboardUrl: string | null;
  };
  legacyPublication?: { url: string | null; updatedAt: string | null };
  connect?: { supabase: boolean; stripe: boolean; vercel?: boolean };
  /** Host can encrypt/store runtime and webhook secrets. */
  secretsConfigured: boolean;
  /** The host has a configured Supabase REST connector in Vercel Connect. */
  supabaseOauthConfigured: boolean;
  /** This app has completed Supabase authorization through Connect. */
  supabaseAccountConnected: boolean;
}

export function emptyIntegrationsProjection(
  options: {
    secretsConfigured?: boolean;
    supabaseOauthConfigured?: boolean;
    supabaseAccountConnected?: boolean;
  } = {},
): SessionIntegrationsProjection {
  return {
    supabase: {
      status: "disconnected",
      projectRef: null,
      projectName: null,
      projectUrl: null,
      linkMethod: null,
      error: null,
    },
    stripe: {
      status: "disconnected",
      mode: null,
      publishableKeyHint: null,
      error: null,
    },
    deploy: {
      status: "idle",
      provider: null,
      deploymentId: null,
      url: null,
      error: null,
      updatedAt: null,
    },
    secretsConfigured: options.secretsConfigured ?? false,
    supabaseOauthConfigured: options.supabaseOauthConfigured ?? false,
    supabaseAccountConnected: options.supabaseAccountConnected ?? false,
  };
}

export function toIntegrationsProjection(
  record: SessionIntegrationsRecord | null,
  options: {
    secretsConfigured: boolean;
    supabaseOauthConfigured: boolean;
    supabaseAccountConnected: boolean;
  },
): SessionIntegrationsProjection {
  if (!record) {
    return emptyIntegrationsProjection(options);
  }
  return {
    supabase: {
      status: record.supabaseStatus,
      projectRef: record.supabaseProjectRef,
      projectName: record.supabaseProjectName,
      projectUrl: record.supabaseProjectUrl,
      linkMethod: record.supabaseLinkMethod,
      error: record.supabaseError,
    },
    stripe: {
      status: record.stripeStatus,
      mode: record.stripeMode,
      publishableKeyHint: record.stripePublishableKeyHint,
      error: record.stripeError,
    },
    deploy: {
      status: record.deployStatus,
      provider: record.deployProvider,
      deploymentId: record.deployId,
      url: record.deployUrl,
      error: record.deployError,
      updatedAt: record.deployUpdatedAt,
    },
    secretsConfigured: options.secretsConfigured,
    supabaseOauthConfigured: options.supabaseOauthConfigured,
    supabaseAccountConnected: options.supabaseAccountConnected,
  };
}

/** Env vars written into the sandbox workspace for the generated app. */
export function buildGeneratedAppEnv(
  record: SessionIntegrationsRecord,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (record.supabaseStatus === "linked") {
    if (!record.supabaseProjectUrl ||
      !record.supabaseSecrets?.anonKey ||
      !record.supabaseSecrets?.serviceRoleKey) {
      throw new Error("Linked Supabase integration has incomplete credentials.");
    }
    env.NEXT_PUBLIC_SUPABASE_URL = record.supabaseProjectUrl;
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = record.supabaseSecrets.anonKey;
    env.SUPABASE_SERVICE_ROLE_KEY = record.supabaseSecrets.serviceRoleKey;
  }
  if (record.stripeStatus === "linked") {
    if (!record.stripeSecrets?.secretKey || (!record.stripeConnectConnector && !record.stripeSecrets.publishableKey)) {
      throw new Error("Linked Stripe integration has incomplete credentials.");
    }
    // Hosted Checkout redirects only require a server key. Connect does not
    // promise that an account's browser publishable key is in token metadata.
    if (record.stripeSecrets.publishableKey) {
      env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = record.stripeSecrets.publishableKey;
    }
    env.STRIPE_SECRET_KEY = record.stripeSecrets.secretKey;
    if (record.stripeSecrets.webhookSecret) {
      env.STRIPE_WEBHOOK_SECRET = record.stripeSecrets.webhookSecret;
    }
  }
  return env;
}

export const INTEGRATION_ENV_BEGIN = "# BEGIN baby-lovable integrations";
export const INTEGRATION_ENV_END = "# END baby-lovable integrations";

const LEGACY_ENV_HEADER =
  "# Managed by baby-lovable backend integrations — do not commit.\n" +
  "# Regenerated when you link/unlink Supabase or Stripe in the Backend panel.\n";
const INTEGRATION_ENV_KEYS = new Set([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);

export function formatEnvFile(env: Record<string, string>): string {
  if (Object.keys(env).length === 0) return "";
  const lines = [INTEGRATION_ENV_BEGIN];
  for (const [key, value] of Object.entries(env)) {
    // dotenv does not reliably unescape quotes/backslashes. Reject ambiguous
    // values, and escape dollars for Next.js dotenv-expand, including ${...}.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof value !== "string" || /[\p{Cc}\p{Zl}\p{Zp}"\\]/u.test(value)) {
      throw new Error("Integration environment contains an unsupported key or value.");
    }
    lines.push(`${key}="${value.replace(/\$/g, "\\$")}"`);
  }
  lines.push(INTEGRATION_ENV_END, "");
  return lines.join("\n");
}

/** Replace only our block; keep user-owned env values, comments and formatting. */
export function mergeIntegrationEnvFile(
  current: string,
  env: Record<string, string>,
): string {
  const block = formatEnvFile(env);
  const lines = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    const text = line.replace(/\r?\n$/, "");
    if (text === INTEGRATION_ENV_BEGIN) {
      if (inside) throw new Error("Invalid managed integration environment block.");
      inside = true;
    } else if (text === INTEGRATION_ENV_END) {
      if (!inside) throw new Error("Invalid managed integration environment block.");
      inside = false;
    } else if (!inside) {
      kept.push(line);
    }
  }
  if (inside) throw new Error("Invalid managed integration environment block.");
  let userEnv = kept.join("");
  // Migrate the original whole-file format without deleting user additions.
  if (userEnv.startsWith(LEGACY_ENV_HEADER)) {
    userEnv = userEnv.slice(LEGACY_ENV_HEADER.length)
      .split(/(?<=\n)/)
      .filter((line) => !INTEGRATION_ENV_KEYS.has(line.match(/^([A-Z_]+)=/)?.[1] ?? ""))
      .join("");
  }
  if (!block) return userEnv;
  // Last assignment wins in dotenv; the managed values must remain at the end.
  return userEnv + (userEnv && !userEnv.endsWith("\n") ? "\n" : "") + block;
}

export function hintPublishableKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 4)}…`;
  }
  return `${trimmed.slice(0, 10)}…${trimmed.slice(-4)}`;
}

export function detectStripeMode(publishableKey: string): StripeMode {
  return publishableKey.trim().startsWith("pk_live_") ? "live" : "test";
}
