import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Encrypt integration secrets at rest (AES-256-GCM).
 * Key: INTEGRATION_SECRETS_KEY — 32-byte hex (64 chars) or base64.
 */
export function getIntegrationSecretsKey(): Buffer {
  const raw = process.env.INTEGRATION_SECRETS_KEY?.trim();
  if (!raw) {
    throw new Error(
      "INTEGRATION_SECRETS_KEY is not configured (32-byte hex or base64).",
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const fromB64 = Buffer.from(raw, "base64");
  if (
    /^[A-Za-z0-9+/]+={0,2}$/.test(raw) &&
    fromB64.length === 32 &&
    fromB64.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "")
  ) {
    return fromB64;
  }
  throw new Error(
    "INTEGRATION_SECRETS_KEY must be 32-byte hex (64 chars) or base64.",
  );
}

export function isIntegrationSecretsKeyConfigured(): boolean {
  try {
    getIntegrationSecretsKey();
    return true;
  } catch {
    return false;
  }
}

/** Ciphertext format: base64(iv || tag || ciphertext) */
export function encryptSecretJson(value: unknown): string {
  const key = getIntegrationSecretsKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export class IntegrationSecretsDecryptionError extends Error {
  constructor() {
    super(
      "Unable to decrypt stored integration credentials. Check INTEGRATION_SECRETS_KEY before retrying.",
    );
    this.name = "IntegrationSecretsDecryptionError";
  }
}

export function decryptSecretJson<T>(ciphertext: string): T {
  try {
    const key = getIntegrationSecretsKey();
    const buf = Buffer.from(ciphertext, "base64");
    if (
      buf.length < IV_LEN + TAG_LEN + 1 ||
      buf.toString("base64") !== ciphertext
    ) {
      throw new Error("Invalid ciphertext");
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    // Do not expose payloads or crypto/provider errors to routes and boot logs.
    throw new IntegrationSecretsDecryptionError();
  }
}
