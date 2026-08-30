/**
 * Shared helpers for Daytona runtime race tests.
 *
 * Model: each "isolate" has an empty process L1 cache but shares the durable
 * in-memory test adapter — matching distinct Vercel/Workflow isolates without
 * adding a production metadata backend.
 */

import type { Session } from "@/lib/session/types";
import { SESSION_SCHEMA_VERSION } from "@/lib/session/types";
import {
  clearRuntimeMemory,
  setRuntimeDurableAdapterForTests,
  type RuntimeDurableAdapter,
} from "@/lib/sandbox/daytona/runtime-store";
import { clearReconcileInFlightForTests } from "@/lib/sandbox/daytona/runtime-reconciler";
import type { DaytonaRuntimeSnapshot } from "@/lib/sandbox/daytona/runtime-state";

export function makeSession(sessionId: string): Session {
  const now = new Date().toISOString();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: sessionId,
    userId: null,
    title: "race-test",
    createdAt: now,
    updatedAt: now,
    messages: [],
    runStatus: "idle",
    conversationRevision: 0,
    turnCheckpoint: -1,
    sandboxMode: "daytona",
  };
}

function createMemoryRuntimeAdapter(): RuntimeDurableAdapter {
  const snapshots = new Map<string, DaytonaRuntimeSnapshot>();
  return {
    requiresUserId: false,
    async read(sessionId) {
      const snapshot = snapshots.get(sessionId);
      return snapshot ? { ...snapshot } : null;
    },
    async write(snapshot, _userId, expectedRevision) {
      const current = snapshots.get(snapshot.sessionId);
      if (expectedRevision === null) {
        if (current) {
          throw new Error(
            `Daytona runtime CAS conflict for ${snapshot.sessionId} (create lost race)`,
          );
        }
      } else if (!current || current.revision !== expectedRevision) {
        throw new Error(
          `Daytona runtime CAS conflict for ${snapshot.sessionId} (expected ${expectedRevision}, got ${current?.revision ?? "missing"})`,
        );
      }
      const saved = { ...snapshot };
      snapshots.set(snapshot.sessionId, saved);
      return { ...saved };
    },
    async delete(sessionId) {
      snapshots.delete(sessionId);
    },
  };
}

export async function withMemoryRuntime<T>(
  fn: (ctx: { sessionId: string }) => Promise<T>,
): Promise<T> {
  const sessionId = `sess_race_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  setRuntimeDurableAdapterForTests(createMemoryRuntimeAdapter());

  try {
    return await fn({ sessionId });
  } finally {
    clearReconcileInFlightForTests();
    setRuntimeDurableAdapterForTests(null);
  }
}

/** Drop L1 — cold start a new serverless isolate in-process. */
export function enterIsolate(sessionId: string): void {
  clearRuntimeMemory(sessionId);
}
