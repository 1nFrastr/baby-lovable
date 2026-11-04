import type { BackendInput } from "@/lib/integrations/backend-schema";

export async function backendStep(
  input: BackendInput,
  { context }: { context: { sessionId: string; turnId?: string } },
) {
  "use step";

  const { runBackendOperation } = await import("@/lib/integrations/backend");
  const { IntegrationError } = await import("@/lib/integrations/service");
  try {
    return await runBackendOperation(input, context.sessionId, context.turnId);
  } catch (error) {
    // Return expected failures so durable workflow retries never repeat opaque mutations.
    return {
      ok: false as const,
      ...(error instanceof IntegrationError && error.operationId ? { operationId: error.operationId } : {}),
      error: error instanceof IntegrationError
        ? error.message
        : "Backend settings could not be loaded. Check the Backend panel and try again.",
    };
  }
}
