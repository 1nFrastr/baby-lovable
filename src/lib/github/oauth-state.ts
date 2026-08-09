import { createHmac, timingSafeEqual } from "node:crypto";

import { getGithubAppClientSecret } from "./app-config";

export interface GithubAppOAuthState {
  sessionId: string;
  userId: string;
  /** Absolute path to return to after callback, e.g. `/sessions/sess_x`. */
  returnTo: string;
  exp: number;
}

function stateSecret(): string {
  const secret = getGithubAppClientSecret();
  if (!secret) {
    throw new Error("GITHUB_APP_CLIENT_SECRET is not configured");
  }
  return secret;
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", stateSecret()).update(payloadB64).digest("base64url");
}

export function encodeGithubAppOAuthState(state: GithubAppOAuthState): string {
  const payloadB64 = Buffer.from(JSON.stringify(state), "utf8").toString(
    "base64url",
  );
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

export function decodeGithubAppOAuthState(raw: string): GithubAppOAuthState {
  const [payloadB64, sig] = raw.split(".");
  if (!payloadB64 || !sig) {
    throw new Error("Invalid OAuth state");
  }
  const expected = signPayload(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid OAuth state signature");
  }
  const parsed = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8"),
  ) as GithubAppOAuthState;
  if (
    typeof parsed.sessionId !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.returnTo !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    throw new Error("Invalid OAuth state payload");
  }
  if (Date.now() > parsed.exp) {
    throw new Error("OAuth state expired");
  }
  if (
    !parsed.returnTo.startsWith("/") ||
    parsed.returnTo.startsWith("//") ||
    parsed.returnTo.includes("://")
  ) {
    throw new Error("Invalid OAuth returnTo");
  }
  return parsed;
}

export function buildGithubAppOAuthState(input: {
  sessionId: string;
  userId: string;
  returnTo?: string;
  /** TTL ms, default 15 minutes. */
  ttlMs?: number;
}): string {
  const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
  return encodeGithubAppOAuthState({
    sessionId: input.sessionId,
    userId: input.userId,
    returnTo: input.returnTo ?? `/sessions/${input.sessionId}`,
    exp: Date.now() + ttlMs,
  });
}
