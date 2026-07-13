/** Quick test: persist + volumeHasSource via volume-sync module on a fresh sandbox. */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { Daytona } from "@daytona/sdk";

import { DaytonaProjectSandbox } from "@/lib/sandbox/daytona-provider";
import { DAYTONA_VOLUME_MOUNT, DAYTONA_WORKSPACE_ROOT } from "@/lib/sandbox/daytona/config";
import { readStarterTemplateFiles } from "@/lib/sandbox/daytona/template-seed";
import {
  isVolumeAccessible,
  persistDaytonaWorkspaceToVolume,
  volumeHasSource,
} from "@/lib/sandbox/daytona/volume-sync";

async function main() {
  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });

  const volume = await daytona.volume.get("baby-lovable-workspaces", true);
  const subpath = `test/sync-${Date.now()}`;

  console.log("Creating sandbox with volume …");
  const sdk = await daytona.create(
    {
      language: "typescript",
      volumes: [{ volumeId: volume.id, mountPath: DAYTONA_VOLUME_MOUNT, subpath }],
    },
    { timeout: 180 },
  );
  await sdk.waitUntilStarted(180);

  const wrapper = new DaytonaProjectSandbox("test-sync", sdk);

  console.log("Volume accessible:", await isVolumeAccessible(wrapper));

  const files = await readStarterTemplateFiles();
  await sdk.fs.uploadFiles(
    files.map((f) => ({
      source: f.content,
      destination: `${DAYTONA_WORKSPACE_ROOT}/${f.relativePath}`,
    })),
  );
  console.log(`Uploaded ${files.length} files to workspace`);

  const synced = await persistDaytonaWorkspaceToVolume(wrapper);
  const hasSource = await volumeHasSource(wrapper);
  console.log("persist:", synced, "volumeHasSource:", hasSource);

  await sdk.delete(60);
  if (!synced || !hasSource) process.exit(1);
  console.log("PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
