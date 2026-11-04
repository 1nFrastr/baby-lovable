import { createHash } from "node:crypto";

import {
  ConnectError,
  getConnectorMetadata,
  getTokenResponse,
  startAuthorization,
  type ConnectTokenParams,
} from "@vercel/connect";

import { IntegrationError } from "./errors";

export type ConnectProvider = "supabase" | "stripe" | "vercel";

export interface AppConnectBinding {
  connector: string;
  subject: "user" | "app";
  /** Vercel publishing connects an account once per authenticated owner. */
  scope?: "owner";
}

/** Each generated app gets an independent grant, derived exclusively on the host. */
export function appConnectSubject(userId: string, sessionId: string): string {
  return `baby-app-${createHash("sha256").update(JSON.stringify([userId, sessionId])).digest("hex")}`;
}

export function configuredSupabaseConnector(): string | null {
  return process.env.VERCEL_CONNECT_SUPABASE_CONNECTOR?.trim() || null;
}

export function configuredStripeConnector(): string | null {
  return process.env.VERCEL_CONNECT_STRIPE_CONNECTOR?.trim() || null;
}

export function configuredVercelConnector(): string | null {
  return process.env.VERCEL_CONNECT_VERCEL_CONNECTOR?.trim() || null;
}

export function ownerConnectSubject(userId: string): string {
  return `baby-user-${createHash("sha256").update(userId).digest("hex")}`;
}

function tokenParams(binding: AppConnectBinding, userId: string, sessionId: string): ConnectTokenParams {
  return {
    subject: binding.subject === "user"
      ? { type: "user", id: binding.scope === "owner" ? ownerConnectSubject(userId) : appConnectSubject(userId, sessionId) }
      : { type: "app" },
  };
}

function requireProjectIdentity(binding: AppConnectBinding) {
  // Access tokens represent their Vercel owner, not a generated app's owner.
  // Do not silently fall back to VERCEL_TOKEN for delegated user subjects.
  if (binding.subject === "user" && !process.env.VERCEL_OIDC_TOKEN?.trim() && !process.env.VERCEL) {
    throw new IntegrationError("Account connection needs the builder's project identity. Please contact support.", 503, "connect_identity_missing");
  }
}

function options(binding: AppConnectBinding) {
  requireProjectIdentity(binding);
  const token = process.env.VERCEL_CONNECT_ACCESS_TOKEN?.trim();
  return binding.subject === "app" && token ? { vercelToken: token } : {};
}

function safeConnectFailure(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof ConnectError && ["user_authorization_required", "no_token", "connector_installation_required"].includes(error.code ?? "")) {
    return new IntegrationError("Reconnect this service in the app's Backend panel.", 409, "connect_authorization_required");
  }
  if (error instanceof ConnectError && error.status === 429) {
    return new IntegrationError("Account connections are busy. Please try again shortly.", 429, "connect_rate_limited");
  }
  // SDK exceptions can include upstream bodies and vendor metadata.
  return new IntegrationError("The account connection could not be verified. Check its setup and permissions.", 503, "connect_unavailable");
}

async function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new IntegrationError("The account connection did not respond in time.", 503, "connect_timeout")), 30_000);
      timer.unref?.();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getAppConnectToken(
  binding: AppConnectBinding,
  userId: string,
  sessionId: string,
  forceRefresh = false,
) {
  try {
    const response = await bounded(getTokenResponse(binding.connector, tokenParams(binding, userId, sessionId), { ...options(binding), forceRefresh }));
    if (!response.token || (response.expiresAt !== 0 && response.expiresAt <= Date.now())) {
      throw new IntegrationError("Reconnect this service in the app's Backend panel.", 409, "connect_authorization_required");
    }
    const tokenId = /^[A-Za-z0-9_-]{1,128}$/.test(response.tokenId ?? "") ? response.tokenId : "unavailable";
    console.info(`[connect] session=${sessionId} event=token_issued subject=${binding.subject} token_id=${tokenId}`);
    return response;
  } catch (error) {
    throw safeConnectFailure(error);
  }
}

export async function startAppConnectAuthorization(
  binding: AppConnectBinding,
  userId: string,
  sessionId: string,
  callbackUrl: string,
) {
  try {
    const authorization = await bounded(startAuthorization(binding.connector, tokenParams(binding, userId, sessionId), {
      ...options(binding), callbackUrl, expiresInMs: 600_000,
    }));
    const url = new URL(authorization.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid authorization URL");
    return url.href;
  } catch (error) {
    throw safeConnectFailure(error);
  }
}

/** Verify the configured connector is for the API provider, never an MCP grant. */
export async function verifyAppConnector(binding: AppConnectBinding, provider: ConnectProvider) {
  try {
    const metadata = await bounded(getConnectorMetadata(binding.connector, options(binding)));
    const allowedTypes = provider === "stripe" ? ["api-key", "stripe-api-key"] : ["oauth"];
    if (metadata.service !== provider || !allowedTypes.includes(metadata.type)) {
      throw new IntegrationError("This connection does not support the requested service API.", 503, "connect_provider_mismatch");
    }
    if (provider === "stripe" && binding.subject === "user") {
      const capabilities = metadata as typeof metadata & { supportedSubjectTypes?: string[]; userTokens?: { manualCredentialInput?: boolean } };
      const userKeyInput = metadata.vendor?.subjectType === "user" ||
        (capabilities.supportedSubjectTypes?.includes("user") && capabilities.userTokens?.manualCredentialInput === true);
      if (metadata.type !== "api-key" || !userKeyInput) {
        throw new IntegrationError("Stripe self-service needs a user-key connector. App credentials must be assigned to one app by an operator.", 503, "connect_subject_mismatch");
      }
    }
    return metadata;
  } catch (error) {
    throw safeConnectFailure(error);
  }
}
