import { normalizeWorkspacePath } from "@/lib/sandbox/protected-paths";

/**
 * In-process per-path mutex for editFile in a session.
 *
 * WorkflowAgent runs same-step tool calls with Promise.all. Without this,
 * two editFile calls on one path can both read the original bytes and the
 * later write drops the earlier change.
 *
 * Lives outside `'use step'` so parallel executes share one isolate queue.
 * Different paths (and different sessions) do not block each other.
 */
const tails = new Map<string, Promise<void>>();

function lockKey(sessionId: string, path: string): string {
  return `${sessionId}:${normalizeWorkspacePath(path)}`;
}

export async function withFileMutationLock<T>(
  sessionId: string,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(sessionId, path);
  const previous = tails.get(key) ?? Promise.resolve();

  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, done);

  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (tails.get(key) === done) {
      tails.delete(key);
    }
  }
}
