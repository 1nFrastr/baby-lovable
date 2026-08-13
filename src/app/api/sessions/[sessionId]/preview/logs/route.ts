import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";
import { DEV_SESSION } from "@/lib/sandbox/daytona/app-server-boot";
import { streamDevCommandLogs } from "@/lib/sandbox/daytona/dev-log-stream";
import { resolveDevCmdId } from "@/lib/sandbox/daytona/resolve-dev-cmd-id";
import {
  getRuntimeSnapshot,
  upsertRuntimeSnapshot,
} from "@/lib/sandbox/daytona/runtime-store";
import { getExistingDaytonaSandbox } from "@/lib/sandbox/daytona/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long-lived SSE proxy for Daytona command log follow. */
export const maxDuration = 300;

type SsePayload =
  | {
      type: "meta";
      generation: number;
      cmdId: string;
      sessionName: string;
    }
  | {
      type: "snapshot";
      stdout: string;
      stderr: string;
      truncated?: boolean;
    }
  | {
      type: "chunk";
      stream: "stdout" | "stderr";
      text: string;
    }
  | { type: "waiting"; reason: string }
  | { type: "stale"; reason: string }
  | { type: "error"; message: string };

function encodeSse(payload: SsePayload): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const SNAPSHOT_STREAM_LIMIT = 100_000;

function boundSnapshot(payload: Extract<SsePayload, { type: "snapshot" }>) {
  const trim = (value: string) =>
    value.length > SNAPSHOT_STREAM_LIMIT
      ? value.slice(-SNAPSHOT_STREAM_LIMIT)
      : value;
  const stdout = trim(payload.stdout);
  const stderr = trim(payload.stderr);
  return {
    ...payload,
    stdout,
    stderr,
    truncated:
      stdout.length !== payload.stdout.length || stderr.length !== payload.stderr.length,
  };
}

function waitingResponse(reason: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeSse({ type: "waiting", reason }));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * SSE: Daytona pnpm-dev stdout/stderr for the Preview Console drawer.
 * Protocol: meta → snapshot → chunk* (or waiting / stale / error).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  let auth;
  try {
    auth = await requireSessionAuth(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }

  try {
    const session = await getSession(sessionId, auth);
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    if (session.sandboxMode !== "daytona") {
      return Response.json(
        { error: "Preview logs are only available for Daytona sessions" },
        { status: 400 },
      );
    }

    const snapshot = await getRuntimeSnapshot(sessionId, auth.userId, {
      fresh: true,
    });
    // The preview URL can recover before a stale-ready reconciliation stores
    // the process identity. Session names are deterministic, so recover the
    // live command instead of leaving Console waiting forever.
    const sessionName =
      snapshot.devSessionName ??
      (snapshot.observed === "preview-ready" ? DEV_SESSION(sessionId) : null);
    const generation = snapshot.generation;

    if (!sessionName) {
      return waitingResponse("Dev session not started yet");
    }

    const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: true });
    if (!sandbox) {
      return waitingResponse(
        "Sandbox unavailable — waiting for preview to start",
      );
    }

    const cmdId = await resolveDevCmdId(
      sandbox.sdkSandbox,
      sessionName,
      snapshot.devCmdId,
    );
    if (!cmdId) {
      return waitingResponse("Dev command id not ready yet");
    }

    // Backfill so refresh / other isolates can attach without re-listing.
    if (
      snapshot.devSessionName !== sessionName ||
      snapshot.devCmdId !== cmdId
    ) {
      try {
        await upsertRuntimeSnapshot(
          sessionId,
          {
            expectedRevision: snapshot.revision,
            devSessionName: sessionName,
            devCmdId: cmdId,
          },
          auth.userId,
        );
      } catch {
        // CAS loss is fine — another writer may have filled it.
      }
    }

    let followAbort: AbortController | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: SsePayload) => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(encodeSse(payload));
          } catch {
            closed = true;
          }
        };

        const cleanup = () => {
          if (closed) {
            followAbort?.abort();
            return;
          }
          closed = true;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          followAbort?.abort();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        send({
          type: "meta",
          generation,
          cmdId,
          sessionName,
        });

        heartbeat = setInterval(() => {
          if (closed) {
            if (heartbeat) {
              clearInterval(heartbeat);
              heartbeat = null;
            }
            return;
          }
          try {
            controller.enqueue(new TextEncoder().encode(`: ping\n\n`));
          } catch {
            cleanup();
          }
        }, 15_000);

        followAbort = new AbortController();
        const onRequestAbort = () => {
          cleanup();
        };
        if (request.signal.aborted) {
          onRequestAbort();
          return;
        }
        request.signal.addEventListener("abort", onRequestAbort, {
          once: true,
        });

        void (async () => {
          try {
            await streamDevCommandLogs(
              sandbox.sdkSandbox,
              sessionName,
              cmdId,
              (event) => {
                send(event.type === "snapshot" ? boundSnapshot(event) : event);
                if (
                  event.type === "waiting" ||
                  event.type === "stale" ||
                  event.type === "error"
                ) {
                  cleanup();
                }
              },
              followAbort!.signal,
            );
          } catch (error) {
            if (!followAbort!.signal.aborted) {
              const message =
                error instanceof Error ? error.message : String(error);
              send({ type: "error", message });
            }
          } finally {
            request.signal.removeEventListener("abort", onRequestAbort);
            cleanup();
          }
        })();
      },
      cancel() {
        followAbort?.abort();
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
