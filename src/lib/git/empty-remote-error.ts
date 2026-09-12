/** Daytona/go-git cannot speak Freestyle's empty-repo receive-pack advertisement. */

export function isZeroIdRefError(error: unknown): boolean {
  const msg = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    msg.includes("malformed zero-id") ||
    msg.includes("illegal zero-id") ||
    msg.includes("too short zero-id") ||
    (msg.includes("zero-id ref") && msg.includes("pkt-line"))
  );
}

/** Pull/push failures that mean Freestyle still has no refs. */
export function isEmptyRemoteGitError(error: unknown): boolean {
  if (isZeroIdRefError(error)) {
    return true;
  }
  const msg = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    msg.includes("couldn't find remote ref") ||
    msg.includes("could not find remote ref") ||
    msg.includes("no upstream") ||
    msg.includes("doesn't have any refs") ||
    msg.includes("does not have any refs") ||
    msg.includes("empty repository") ||
    msg.includes("remote empty") ||
    msg.includes("git-upload-pack") ||
    msg.includes("connection reset") ||
    msg.includes("repository not found")
  );
}
