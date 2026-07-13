import { getDaytonaVolumeName } from "./config";
import { getDaytonaClient } from "./client";

type SharedVolume = Awaited<
  ReturnType<ReturnType<typeof getDaytonaClient>["volume"]["get"]>
>;

let sharedVolumePromise: Promise<SharedVolume> | null = null;

export async function ensureSharedVolume(): Promise<SharedVolume> {
  if (!sharedVolumePromise) {
    sharedVolumePromise = (async () => {
      const daytona = getDaytonaClient();
      const name = getDaytonaVolumeName();
      return daytona.volume.get(name, true);
    })();
  }

  return sharedVolumePromise;
}
