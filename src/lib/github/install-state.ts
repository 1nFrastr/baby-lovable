import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
} from "node:crypto";

import { getGithubAppPrivateKey } from "./app-config";

export interface GithubAppInstallState {
  sessionId: string;
  userId: string | null;
  /** Absolute path to return to after setup, e.g. `/sessions/sess_x`. */
  returnTo: string;
  exp: number;
}

function privateKey() {
  const raw = getGithubAppPrivateKey();
  if (!raw) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not configured");
  }
  return createPrivateKey(raw);
}

function signPayload(payloadB64: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(payloadB64);
  signer.end();
  return signer.sign(privateKey()).toString("base64url");
}

export function encodeGithubAppInstallState(
  state: GithubAppInstallState,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(state), "utf8").toString(
    "base64url",
  );
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

export function decodeGithubAppInstallState(
  raw: string,
): GithubAppInstallState {
  const [payloadB64, signatureB64] = raw.split(".");
  if (!payloadB64 || !signatureB64) {
    throw new Error("Invalid GitHub installation state");
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(payloadB64);
  verifier.end();
  const valid = verifier.verify(
    createPublicKey(privateKey()),
    Buffer.from(signatureB64, "base64url"),
  );
  if (!valid) {
    throw new Error("Invalid GitHub installation state signature");
  }

  const parsed = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8"),
  ) as GithubAppInstallState;
  if (
    typeof parsed.sessionId !== "string" ||
    (parsed.userId !== null && typeof parsed.userId !== "string") ||
    typeof parsed.returnTo !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    throw new Error("Invalid GitHub installation state payload");
  }
  if (Date.now() > parsed.exp) {
    throw new Error("GitHub installation state expired");
  }
  if (
    !parsed.returnTo.startsWith("/") ||
    parsed.returnTo.startsWith("//") ||
    parsed.returnTo.includes("://")
  ) {
    throw new Error("Invalid GitHub installation returnTo");
  }
  return parsed;
}

export function buildGithubAppInstallState(input: {
  sessionId: string;
  userId: string | null;
  returnTo?: string;
  /** TTL ms, default 15 minutes. */
  ttlMs?: number;
}): string {
  return encodeGithubAppInstallState({
    sessionId: input.sessionId,
    userId: input.userId,
    returnTo: input.returnTo ?? `/sessions/${input.sessionId}`,
    exp: Date.now() + (input.ttlMs ?? 15 * 60 * 1000),
  });
}
