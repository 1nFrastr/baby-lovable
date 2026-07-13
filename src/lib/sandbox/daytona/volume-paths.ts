/**
 * Volume subpath layout — mirrors local `paths.ts` semantics without host disk.
 *
 *   users/{userId}/sessions/{sessionId}   (authenticated)
 *   sessions/{sessionId}                  (anonymous CLI)
 */
export function getVolumeSubpath(
  sessionId: string,
  userId: string | null = null,
): string {
  if (userId) {
    return `users/${userId}/sessions/${sessionId}`;
  }
  return `sessions/${sessionId}`;
}
