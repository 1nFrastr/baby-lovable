/**
 * Durable step: create Freestyle remote + bind session git record.
 * Node / freestyle SDK only via dynamic import inside the step body.
 */
export async function provisionFreestyleRepoStep(
  sessionId: string,
  userId: string | null,
): Promise<{ repoId: string | null }> {
  "use step";

  const {
    ensureFreestyleRepository,
    markRepositoryProvisionError,
    redactSecrets,
  } = await import("@/lib/git/provision-repo");

  try {
    const repo = await ensureFreestyleRepository(sessionId, userId);
    return { repoId: repo.repoId };
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    await markRepositoryProvisionError(sessionId, message, userId);
    throw error;
  }
}
