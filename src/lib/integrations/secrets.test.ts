import { processEnv } from "@next/env";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  decryptSecretJson,
  encryptSecretJson,
  getIntegrationSecretsKey,
  IntegrationSecretsDecryptionError,
} from "@/lib/integrations/secrets";
import {
  readSessionIntegrations,
  IntegrationStorageNotReadyError,
} from "@/lib/integrations/store";
import {
  buildGeneratedAppEnv,
  formatEnvFile,
  mergeIntegrationEnvFile,
  INTEGRATION_ENV_BEGIN,
  INTEGRATION_ENV_END,
  hintPublishableKey,
  detectStripeMode,
} from "@/lib/integrations/types";
import type { SessionIntegrationsRecord } from "@/lib/integrations/types";

const database = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => database,
}));

function queryResult(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
}

describe("integration secrets", () => {
  const prev = process.env.INTEGRATION_SECRETS_KEY;

  beforeEach(() => {
    process.env.INTEGRATION_SECRETS_KEY = "a".repeat(64);
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.INTEGRATION_SECRETS_KEY;
    } else {
      process.env.INTEGRATION_SECRETS_KEY = prev;
    }
  });

  it("round-trips JSON payloads", () => {
    const payload = { anonKey: "a", serviceRoleKey: "b" };
    const cipher = encryptSecretJson(payload);
    expect(cipher).not.toContain("anonKey");
    expect(decryptSecretJson<typeof payload>(cipher)).toEqual(payload);
    expect(encryptSecretJson(payload)).not.toBe(cipher);
  });

  it("rejects tampering, wrong keys, malformed ciphertext, and missing keys explicitly", () => {
    const cipher = encryptSecretJson({ secret: "do-not-log-this" });
    const bytes = Buffer.from(cipher, "base64");
    bytes[bytes.length - 1] ^= 1;
    expect(() => decryptSecretJson(bytes.toString("base64")))
      .toThrow(IntegrationSecretsDecryptionError);
    expect(() => decryptSecretJson(cipher + "!"))
      .toThrow(IntegrationSecretsDecryptionError);
    expect(() => decryptSecretJson("short"))
      .toThrow(IntegrationSecretsDecryptionError);
    process.env.INTEGRATION_SECRETS_KEY = "b".repeat(64);
    expect(() => decryptSecretJson(cipher)).toThrow(IntegrationSecretsDecryptionError);
    delete process.env.INTEGRATION_SECRETS_KEY;
    expect(() => decryptSecretJson(cipher)).toThrow(IntegrationSecretsDecryptionError);
  });

  it("accepts base64 keys and rejects noncanonical junk accepted by Buffer", () => {
    const key = Buffer.alloc(32, 7);
    process.env.INTEGRATION_SECRETS_KEY = key.toString("base64");
    expect(getIntegrationSecretsKey()).toEqual(key);
    process.env.INTEGRATION_SECRETS_KEY = key.toString("base64") + "!";
    expect(() => getIntegrationSecretsKey()).toThrow("must be 32-byte");
  });

  it("reads metadata without selecting ciphertext or requiring a key", async () => {
    delete process.env.INTEGRATION_SECRETS_KEY;
    const query = queryResult({
      session_id: "sess_1",
      user_id: "user_1",
      // A faulty test adapter returning ciphertext must still never decrypt it.
      supabase_secrets_ciphertext: "invalid",
      stripe_secrets_ciphertext: "invalid",
    });
    database.from.mockReturnValue(query);
    const metadata = await readSessionIntegrations("sess_1", false);
    expect(metadata?.supabaseSecrets).toBeNull();
    expect(metadata?.stripeSecrets).toBeNull();
    expect(query.select.mock.calls[0][0]).not.toContain("ciphertext");
    await expect(readSessionIntegrations("sess_1"))
      .rejects.toThrow(IntegrationSecretsDecryptionError);
  });

  it("distinguishes absent records from unapplied storage migrations", async () => {
    database.from.mockReturnValue(queryResult(null));
    await expect(readSessionIntegrations("sess_1")).resolves.toBeNull();
    database.from.mockReturnValue(queryResult(null, { code: "PGRST205" }));
    await expect(readSessionIntegrations("sess_1"))
      .rejects.toThrow(IntegrationStorageNotReadyError);
  });

});

describe("generated app env", () => {
  const base: SessionIntegrationsRecord = {
    sessionId: "sess_1",
    userId: "user_1",
    supabaseStatus: "disconnected",
    supabaseProjectRef: null,
    supabaseProjectName: null,
    supabaseProjectUrl: null,
    supabaseLinkMethod: null,
    supabaseSecrets: null,
    supabaseError: null,
    stripeStatus: "disconnected",
    stripeMode: null,
    stripePublishableKeyHint: null,
    stripeSecrets: null,
    stripeError: null,
    deployStatus: "idle",
    deployProvider: null,
    deployId: null,
    deployUrl: null,
    deployError: null,
    deployUpdatedAt: null,
    updatedAt: new Date().toISOString(),
  };

  it("emits supabase and stripe keys when linked", () => {
    const env = buildGeneratedAppEnv({
      ...base,
      supabaseStatus: "linked",
      supabaseProjectUrl: "https://abc.supabase.co",
      supabaseSecrets: { anonKey: "anon", serviceRoleKey: "service" },
      stripeStatus: "linked",
      stripeSecrets: {
        publishableKey: "pk_test_x",
        secretKey: "sk_test_y",
        webhookSecret: "whsec_z",
      },
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://abc.supabase.co");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon");
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("service");
    expect(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).toBe("pk_test_x");
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_y");
    expect(env.STRIPE_WEBHOOK_SECRET).toBe("whsec_z");
    expect(formatEnvFile(env)).toContain('NEXT_PUBLIC_SUPABASE_URL=');
  });

  it("refuses linked integrations with missing credentials", () => {
    expect(() => buildGeneratedAppEnv({ ...base, supabaseStatus: "linked" }))
      .toThrow("incomplete credentials");
    expect(() => buildGeneratedAppEnv({ ...base, stripeStatus: "linked" }))
      .toThrow("incomplete credentials");
  });

  it("preserves literal dollars through the actual Next.js dotenv expansion", () => {
    const previous = { ...process.env };
    try {
      const literal = "$SECRET ${SECRET} $$ # = 'value'";
      const [, parsed] = processEnv([{
        path: ".env.local",
        contents: formatEnvFile({ BABY_TEST_LITERAL: literal }),
        env: {},
      }], undefined, console, true);
      expect(parsed.BABY_TEST_LITERAL).toBe(literal);
    } finally {
      process.env = previous;
    }
  });

  it.each([
    "safe\nINJECTED=true",
    "safe\rINJECTED=true",
    'safe"\nINJECTED="true',
    "ambiguous\\nvalue",
    "nul" + String.fromCharCode(0),
    "line" + String.fromCharCode(0x2028),
  ])("rejects dotenv injection without including the value in errors", (value) => {
    expect(() => formatEnvFile({ SECRET: value })).toThrow("unsupported key or value");
    expect(() => formatEnvFile({ "KEY\nINJECTED": "value" }))
      .toThrow("unsupported key or value");
  });

  it("replaces only managed entries and removes stale keys on unlink", () => {
    const user = "# My app settings\nDATABASE_URL='custom'\n";
    const original = user + formatEnvFile({ STRIPE_SECRET_KEY: "old", STRIPE_WEBHOOK_SECRET: "old-hook" });
    const rotated = mergeIntegrationEnvFile(original, { STRIPE_SECRET_KEY: "new" });
    expect(rotated).toBe(user + formatEnvFile({ STRIPE_SECRET_KEY: "new" }));
    expect(mergeIntegrationEnvFile(rotated, {})).toBe(user);
    expect(mergeIntegrationEnvFile(rotated, { STRIPE_SECRET_KEY: "new" })).toBe(rotated);
    expect(mergeIntegrationEnvFile(user, {})).toBe(user);
  });

  it("migrates the old generated file while retaining user additions", () => {
    const legacy = "# Managed by baby-lovable backend integrations — do not commit.\n" +
      "# Regenerated when you link/unlink Supabase or Stripe in the Backend panel.\n" +
      'STRIPE_SECRET_KEY="old"\nUSER_SETTING="keep"\n';
    expect(mergeIntegrationEnvFile(legacy, {})).toBe('USER_SETTING="keep"\n');
  });

  it("fails closed on incomplete managed markers", () => {
    expect(() => mergeIntegrationEnvFile(INTEGRATION_ENV_BEGIN + "\nSECRET=x", {}))
      .toThrow("Invalid managed");
    expect(() => mergeIntegrationEnvFile(INTEGRATION_ENV_END + "\n", {}))
      .toThrow("Invalid managed");
  });

  it("hints publishable keys and detects mode", () => {
    expect(detectStripeMode("pk_live_abc")).toBe("live");
    expect(detectStripeMode("pk_test_abc")).toBe("test");
    expect(hintPublishableKey("pk_test_abcdefghijklmnop")).toMatch(/^pk_test_ab/);
  });
});
