/** Test Daytona SDK native git on a fresh sandbox. */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });

import { Daytona } from "@daytona/sdk";

import { DaytonaProjectSandbox } from "@/lib/sandbox/daytona-provider";
import { DAYTONA_WORKSPACE_ROOT } from "@/lib/sandbox/daytona/config";
import { commitWorkspaceTurn } from "@/lib/sandbox/workspace-git";

async function main() {
  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });

  console.log("Creating sandbox …");
  const sdk = await daytona.create({ language: "typescript" }, { timeout: 180 });
  await sdk.waitUntilStarted(180);
  const wrapper = new DaytonaProjectSandbox("test-git", sdk);

  await sdk.fs.uploadFile(
    Buffer.from('{"name":"test"}'),
    `${DAYTONA_WORKSPACE_ROOT}/package.json`,
  );
  console.log("Wrote package.json");

  const result = await commitWorkspaceTurn(wrapper, {
    turnIndex: 1,
    userPrompt: "test commit",
    messageOverride: "test: sdk git commit",
  });
  console.log("commit result:", result);

  await sdk.delete(60);
  if (!result.committed || !result.sha) process.exit(1);
  console.log("PASS sha=", result.sha);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
