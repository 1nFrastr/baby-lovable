import { sleep } from "workflow";

import { reconcileVercelPublishStep } from "./vercel-publish-steps";

/** Durable polling continues after the browser and originating request close. */
export async function vercelPublishWorkflow(jobId: string, userId: string) {
  "use workflow";
  for (;;) {
    const result = await reconcileVercelPublishStep(jobId, userId);
    if (result.done) return;
    await sleep(new Date(Date.now() + result.delayMs));
  }
}
