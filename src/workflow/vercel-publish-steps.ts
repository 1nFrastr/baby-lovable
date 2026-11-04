import { reconcileVercelPublication } from "@/lib/integrations/vercel-publish";

export async function reconcileVercelPublishStep(jobId: string, userId: string) {
  "use step";
  return reconcileVercelPublication(jobId, userId);
}

// Replayed steps reconcile persisted intent before any provider mutation.
reconcileVercelPublishStep.maxRetries = 3;
