import "@/lib/load-host-env";

import { getAppConnectToken, verifyAppConnector } from "@/lib/integrations/connect";
import { assignStripeConnectApp, readSessionIntegrations } from "@/lib/integrations/store";
import { getSessionMeta } from "@/lib/session/store";

/** Operator utility: binds a previously authorized, dedicated managed connector. */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.info("Usage: npm run connect:bind-stripe -- --session sess_ID --connector scl_ID [--apply]\nDefault: verify only. The connector must already be authorized, attached to the host project, and dedicated to this generated app.");
    return;
  }
  const sessionId = args[args.indexOf("--session") + 1];
  const connector = args[args.indexOf("--connector") + 1];
  if (!args.includes("--session") || !args.includes("--connector") || !sessionId || !/^(?:scl_[A-Za-z0-9]+|stripe\/[A-Za-z0-9_-]+)$/.test(connector ?? "")) {
    throw new Error("Usage: npm run connect:bind-stripe -- --session sess_ID --connector scl_ID [--apply]");
  }
  const session = await getSessionMeta(sessionId);
  if (!session?.userId) throw new Error("An app owner is required.");
  if (["pending", "running", "cancelling"].includes(session.runStatus)) throw new Error("Wait for the current app changes to finish.");
  const existing = await readSessionIntegrations(sessionId, false);
  if (existing?.stripeStatus === "linked") throw new Error("Unlink the existing Stripe connection before assigning another account.");
  const metadata = await verifyAppConnector({ connector, subject: "app" }, "stripe");
  // Canonicalize aliases so UID and scl_ID cannot bypass the DB uniqueness guard.
  if (!/^scl_[A-Za-z0-9]+$/.test(metadata.id)) throw new Error("An opaque connector ID is required.");
  const binding = { connector: metadata.id, subject: "app" as const };
  const grant = await getAppConnectToken(binding, session.userId, sessionId, true);
  if (!/^(?:rk|sk)_(test|live)_[A-Za-z0-9]+$/.test(grant.token)) throw new Error("A Stripe API credential is required.");
  if (!args.includes("--apply")) {
    console.info("Verified the dedicated Stripe connector. Pass --apply to assign it to the app. No credentials are printed or stored.");
    return;
  }
  await assignStripeConnectApp(sessionId, session.userId, binding.connector);
  console.info("Assigned the dedicated Stripe connector. The app owner can now select Connect Stripe in Backend.");
}

main().catch(() => {
  // Never print SDK/provider exceptions or their potentially sensitive causes.
  console.error("Stripe connection assignment did not complete. Check the session, connector, permissions, and command arguments. Run without --apply to verify setup first.");
  process.exitCode = 1;
});
