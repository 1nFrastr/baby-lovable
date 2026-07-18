import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { subscribeRuntimeEvents } from "@/lib/session/runtime-events-hub";
import {
  ensureRuntimeProjection,
  getRuntimeTransport,
} from "@/lib/session/runtime-projection-store";
import type { SessionRuntimeProjection } from "@/lib/session/runtime-projection";
import { getSession } from "@/lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * File-store only SSE fanout for SessionRuntimeProjection.
 * Supabase persist backend uses Realtime — this route returns 404 there.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  if (getRuntimeTransport() !== "sse") {
    return Response.json(
      {
        error:
          "SSE /events is only available in local file-store mode. Use Supabase Realtime when persist backend is Supabase.",
      },
      { status: 404 },
    );
  }

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

    const initial = await ensureRuntimeProjection(sessionId, session.userId);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (projection: SessionRuntimeProjection) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(projection)}\n\n`),
          );
        };

        send(initial);

        const unsubscribe = subscribeRuntimeEvents(sessionId, send);
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            clearInterval(heartbeat);
            unsubscribe();
          }
        }, 15_000);

        const onAbort = () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        if (request.signal.aborted) {
          onAbort();
          return;
        }
        request.signal.addEventListener("abort", onAbort);
      },
      cancel() {
        // abort listener handles cleanup
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
