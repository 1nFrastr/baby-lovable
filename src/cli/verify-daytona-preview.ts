import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { checkDaytonaAppServer } from "@/lib/sandbox/daytona/app-server";
import { ensureDesiredState } from "@/lib/sandbox/daytona/runtime-reconciler";
import { getExistingDaytonaSandbox } from "@/lib/sandbox/daytona/sandbox";

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("Usage: npx tsx src/cli/verify-daytona-preview.ts <sessionId>");
    process.exit(1);
  }

  await ensureDesiredState(sessionId, "preview-ready", { wait: true });
  const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: true });
  if (!sandbox) {
    throw new Error(`Daytona sandbox not available for ${sessionId}`);
  }
  const page = await sandbox.fs.readTextFile("src/app/page.tsx");
  console.log("--- workspace src/app/page.tsx ---");
  console.log(page);

  const report = await checkDaytonaAppServer(sessionId);
  console.log("\n--- preview report ---");
  console.log(JSON.stringify(report, null, 2));

  if (report.url) {
    const port = Number(process.env.DAYTONA_DEV_PORT ?? 3000);
    const preview = await sandbox.sdkSandbox.getPreviewLink(port);
    const response = await fetch(report.url, {
      headers: { "x-daytona-preview-token": preview.token },
    });
    const html = await response.text();
    const titleMatch = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
    console.log("\n--- rendered h1 ---");
    console.log(titleMatch?.[1] ?? "(not found in HTML)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
