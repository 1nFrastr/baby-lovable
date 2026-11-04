import { start } from "workflow/api";

import { isWorkflowRunActive, newClaimToken } from "@/lib/git/workflow-run";
import { claimPublishWorkflow, setPublishWorkflow, type PublishJob } from "@/lib/integrations/vercel-publish-store";

import { vercelPublishWorkflow } from "./vercel-publish";

/** CAS-start one durable worker; GET status can recover an interrupted start. */
export async function kickVercelPublishWorkflow(job: PublishJob, manual = false) {
  if (!job.active || (job.phase === "uncertain" && !manual) || await isWorkflowRunActive(job.workflow_run_id)) return;
  const claim = newClaimToken();
  if (!await claimPublishWorkflow(job, claim)) return;
  try {
    const run = await start(vercelPublishWorkflow, [job.id, job.user_id]);
    await setPublishWorkflow(job, claim, run.runId);
  } catch {
    // No detached in-process fallback: the job remains durable and recoverable.
    await setPublishWorkflow(job, claim, null);
    console.warn(`[publish] job=${job.id} event=workflow_start_pending`);
  }
}
