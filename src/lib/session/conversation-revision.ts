/** Session detail keyed by the monotonic conversation revision. */
export interface RevisionedSessionDetail {
  session: {
    conversationRevision: number;
  };
}

/**
 * A fetched session may replace the cached one only when its revision is
 * the same or newer. An older response must not clobber a newer snapshot.
 */
export function preferSessionDetail<T extends RevisionedSessionDetail>(
  current: T | undefined,
  incoming: T,
): T {
  if (
    current &&
    incoming.session.conversationRevision < current.session.conversationRevision
  ) {
    return current;
  }
  return incoming;
}
