/**
 * Pure cold-start bench: create session → ensureDesiredState(preview-ready).
 * No agent / no file tools — isolates sandbox + Next boot timing.
 *
 * Usage: npx tsx src/cli/bench-daytona-coldstart.ts
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { createSession } from "@/lib/session/store";
import { ensureDesiredState } from "@/lib/sandbox/daytona/runtime-reconciler";
import { getRuntimeSnapshot } from "@/lib/sandbox/daytona/runtime-store";

async function main() {
  const t0 = Date.now();
  const session = await createSession({
    title: "coldstart-bench",
    sandboxMode: "daytona",
  });
  console.warn(`[bench] session=${session.id} created ms=${Date.now() - t0}`);

  const tWarm = Date.now();
  const snap = await ensureDesiredState(session.id, "preview-ready", {
    wait: true,
  });
  const warmMs = Date.now() - tWarm;
  const fresh = await getRuntimeSnapshot(session.id, null, { fresh: true });

  console.warn(
    `[bench] done session=${session.id} warmMs=${warmMs} totalMs=${Date.now() - t0}`,
  );
  console.warn(
    `[bench] observed=${fresh.observed} httpUrl=${fresh.previewUrl ?? "null"} ` +
      `sandboxId=${fresh.sandboxId?.slice(0, 12) ?? "null"} ` +
      `err=${fresh.lastError ?? "none"}`,
  );
  console.warn(`[bench] ensureDesired returned observed=${snap.observed}`);

  if (fresh.observed !== "preview-ready") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
