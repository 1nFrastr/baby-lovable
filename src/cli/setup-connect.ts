import "@/lib/load-host-env";

import { integrationFetch } from "@/lib/integrations/http";

async function main() {
  const args = process.argv.slice(2);
  const provider = args[args.indexOf("--provider") + 1];
  if (args.includes("--help") || !args.includes("--provider") || !["supabase", "stripe"].includes(provider)) {
    console.info("Usage: npm run connect:setup -- --provider supabase|stripe [--apply]\nDefault: show setup requirements without creating a connector. Stripe creates a user-key connector; provision managed keys with the Vercel CLI.");
    return;
  }
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  const token = process.env.VERCEL_CONNECT_SETUP_TOKEN?.trim();
  if (!teamId || !projectId || !token) throw new Error("setup_missing");
  const environments = (process.env.VERCEL_CONNECT_SETUP_ENVIRONMENTS ?? "development").split(",").map((value) => value.trim()).filter(Boolean);
  if (!environments.length) throw new Error("setup_missing");
  let data: Record<string, unknown>;
  if (provider === "supabase") {
    const clientId = process.env.CONNECT_SETUP_SUPABASE_CLIENT_ID?.trim();
    const clientSecret = process.env.CONNECT_SETUP_SUPABASE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error("setup_missing");
    data = {
      clientId, clientSecret,
      serverConfig: {
        authorization_endpoint: "https://api.supabase.com/v1/oauth/authorize",
        token_endpoint: "https://api.supabase.com/v1/oauth/token",
        token_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"],
      },
      tokenEndpointAuthMethod: "client_secret_basic", responseType: "code", pkceRequired: true, codeChallengeMethod: "S256",
      userAuthorization: { enabled: true }, refreshTokens: { enabled: true }, clientCredentials: { enabled: false },
    };
  } else {
    data = { subjectType: "user", serviceUrls: ["https://api.stripe.com"], instructions: "Use a restricted Stripe test key while building. Grant only the permissions your app needs, including account and balance read for connection checks, Checkout and required billing resources, and webhook endpoint read/write for payment notifications. Never use the builder platform's own Stripe account." };
  }
  if (!args.includes("--apply")) {
    console.info(`Ready to create the ${provider} connector and attach it to the configured host project. Provider secrets will not be printed. Review docs/generated-app-backends.md, then pass --apply to create it.`);
    return;
  }
  const response = await integrationFetch("Vercel Connect", `https://api.vercel.com/v1/connect/connectors?teamId=${encodeURIComponent(teamId)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: provider === "supabase" ? "oauth" : "api-key", service: provider, name: provider === "supabase" ? "baby-supabase-management" : "baby-stripe-users", projectId, environments, data }),
  });
  const connector = await response.json() as { id?: string; uid?: string };
  const reference = connector.id;
  if (!reference || !/^scl_[A-Za-z0-9]+$/.test(reference)) {
    throw new Error("setup_uncertain");
  }
  console.info(`Connector created and attached. Configure VERCEL_CONNECT_${provider.toUpperCase()}_CONNECTOR=${reference} on the host. Remove the one-time setup credentials afterward.`);
}

main().catch(() => {
  console.error("Connect setup did not complete. Check the one-time setup variables and provider permissions. If a request was interrupted, inspect existing connectors before retrying to avoid duplicates. No provider error body or credential is included here.");
  process.exitCode = 1;
});
