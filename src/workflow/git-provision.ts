import { provisionFreestyleRepoStep } from "./git-provision-steps";

/**
 * Durable Freestyle repo provisioning — creates the private remote and binds
 * it on the session git record (still `preparing` until reconciler hydrates).
 *
 * Keep this file free of Node / freestyle imports (workflow sandbox).
 */
export async function provisionFreestyleRepoWorkflow(
  sessionId: string,
  userId: string | null = null,
): Promise<{ repoId: string | null }> {
  "use workflow";

  return provisionFreestyleRepoStep(sessionId, userId);
}
