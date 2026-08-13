/**
 * Daytona runtime store — durable snapshot + lease for single-writer reconcile.
 * Supabase `session_daytona_runtime` is the production durable store.
 *
 * L1 `memory` is process-local (one serverless isolate). Writers always CAS
 * against durable state so a stale L1 cannot clobber another isolate's write.
 */

import { getSession } from "@/lib/session/store";

import {
  emptyRuntimeSnapshot,
  type DaytonaRuntimePatch,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";
import {
  deleteRuntimeSupabase,
  readRuntimeSupabase,
  writeRuntimeSupabase,
} from "./runtime-store-supabase";

const memory = new Map<string, DaytonaRuntimeSnapshot>();

const DEFAULT_LEASE_TTL_MS = 30_000;

export interface RuntimeDurableAdapter {
  /** Supabase requires the owning auth user; in-memory unit adapters do not. */
  requiresUserId?: boolean;
  read(sessionId: string): Promise<DaytonaRuntimeSnapshot | null>;
  write(
    snapshot: DaytonaRuntimeSnapshot,
    userId: string | null,
    expectedRevision: number | null,
  ): Promise<DaytonaRuntimeSnapshot>;
  delete(sessionId: string): Promise<void>;
}

const supabaseAdapter: RuntimeDurableAdapter = {
  requiresUserId: true,
  read: readRuntimeSupabase,
  write: writeRuntimeSupabase,
  delete: deleteRuntimeSupabase,
};

let durableAdapter: RuntimeDurableAdapter = supabaseAdapter;

/** Unit tests inject an in-memory CAS adapter; production always uses Supabase. */
export function setRuntimeDurableAdapterForTests(
  adapter: RuntimeDurableAdapter | null,
): void {
  durableAdapter = adapter ?? supabaseAdapter;
  clearRuntimeMemory();
}

function isLeaseActive(snapshot: DaytonaRuntimeSnapshot, now = Date.now()): boolean {
  if (!snapshot.leaseOwner || !snapshot.leaseExpiresAt) {
    return false;
  }
  return Date.parse(snapshot.leaseExpiresAt) > now;
}

async function resolveUserId(
  sessionId: string,
  userId: string | null = null,
): Promise<string | null> {
  if (userId) {
    return userId;
  }
  const session = await getSession(sessionId);
  return session?.userId ?? null;
}

async function loadDurable(
  sessionId: string,
  userId: string | null,
): Promise<DaytonaRuntimeSnapshot | null> {
  void userId;
  return durableAdapter.read(sessionId);
}

/**
 * Persist with optimistic concurrency.
 * - expectedRevision === null → create-only (fail if durable row exists)
 * - otherwise → update only when the durable revision matches
 */
async function saveDurable(
  snapshot: DaytonaRuntimeSnapshot,
  userId: string | null,
  expectedRevision: number | null,
): Promise<DaytonaRuntimeSnapshot> {
  return durableAdapter.write(snapshot, userId, expectedRevision);
}

export type GetRuntimeOptions = {
  /** Skip L1 cache and reload from durable store (cross-isolate freshness). */
  fresh?: boolean;
};

export async function getRuntimeSnapshot(
  sessionId: string,
  userId: string | null = null,
  options?: GetRuntimeOptions,
): Promise<DaytonaRuntimeSnapshot> {
  if (!options?.fresh) {
    const hit = memory.get(sessionId);
    if (hit) {
      return { ...hit };
    }
  }

  const ownerId =
    durableAdapter.requiresUserId === false
      ? userId
      : await resolveUserId(sessionId, userId);
  let loaded = await loadDurable(sessionId, ownerId);

  if (!loaded) {
    loaded = emptyRuntimeSnapshot(sessionId);
  }

  memory.set(sessionId, loaded);
  return { ...loaded };
}

export async function upsertRuntimeSnapshot(
  sessionId: string,
  patch: DaytonaRuntimePatch,
  userId: string | null = null,
): Promise<DaytonaRuntimeSnapshot> {
  const ownerId =
    durableAdapter.requiresUserId === false
      ? userId
      : await resolveUserId(sessionId, userId);
  // Writers always CAS against durable truth — never against a stale L1 copy.
  const durable = await loadDurable(sessionId, ownerId);
  const current = durable ?? emptyRuntimeSnapshot(sessionId);
  const expectedRevision = patch.expectedRevision ?? current.revision;

  if (expectedRevision !== current.revision) {
    throw new Error(
      `Daytona runtime CAS conflict for ${sessionId} (expected ${expectedRevision}, got ${current.revision})`,
    );
  }

  const fields = { ...patch };
  delete fields.expectedRevision;
  const next: DaytonaRuntimeSnapshot = {
    ...current,
    ...fields,
    sessionId,
    revision: current.revision + 1,
  };

  const saved = await saveDurable(
    next,
    ownerId,
    durable ? current.revision : null,
  );
  memory.set(sessionId, saved);

  // Publish UI projection only when derived preview fields change (lease-only CAS no-ops).
  void publishPreviewFromSnapshot(saved, ownerId);

  return { ...saved };
}

async function publishPreviewFromSnapshot(
  snapshot: DaytonaRuntimeSnapshot,
  userId: string | null,
): Promise<void> {
  try {
    const { deriveAllStatus } = await import("./runtime-state");
    const { previewFromAllStatus } = await import(
      "@/lib/session/runtime-projection"
    );
    const { publishRuntimeUpdate } = await import(
      "@/lib/session/runtime-projection-store"
    );
    const all = deriveAllStatus(snapshot);
    await publishRuntimeUpdate(
      snapshot.sessionId,
      {
        preview: previewFromAllStatus(
          all,
          snapshot.generation,
          new Date().toISOString(),
        ),
      },
      userId,
    );
  } catch {
    // Best-effort — durable daytona runtime remains source of truth.
  }
}

export async function acquireRuntimeLease(
  sessionId: string,
  owner: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
  userId: string | null = null,
): Promise<DaytonaRuntimeSnapshot | null> {
  const current = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
  const now = Date.now();

  if (isLeaseActive(current, now) && current.leaseOwner !== owner) {
    return null;
  }

  try {
    return await upsertRuntimeSnapshot(
      sessionId,
      {
        expectedRevision: current.revision,
        leaseOwner: owner,
        leaseExpiresAt: new Date(now + ttlMs).toISOString(),
      },
      userId,
    );
  } catch {
    return null;
  }
}

export async function renewRuntimeLease(
  sessionId: string,
  owner: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
  userId: string | null = null,
): Promise<DaytonaRuntimeSnapshot | null> {
  const current = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
  if (current.leaseOwner !== owner) {
    return null;
  }

  try {
    return await upsertRuntimeSnapshot(
      sessionId,
      {
        expectedRevision: current.revision,
        leaseOwner: owner,
        leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
      },
      userId,
    );
  } catch {
    return null;
  }
}

export async function releaseRuntimeLease(
  sessionId: string,
  owner: string,
  userId: string | null = null,
): Promise<void> {
  const current = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
  if (current.leaseOwner !== owner) {
    return;
  }

  try {
    await upsertRuntimeSnapshot(
      sessionId,
      {
        expectedRevision: current.revision,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      userId,
    );
  } catch {
    // ignore — lease expiry will reclaim
  }
}

export async function clearRuntimeSnapshot(
  sessionId: string,
  userId: string | null = null,
): Promise<void> {
  memory.delete(sessionId);
  const ownerId =
    durableAdapter.requiresUserId === false
      ? userId
      : await resolveUserId(sessionId, userId);

  try {
    void ownerId;
    await durableAdapter.delete(sessionId);
  } catch {
    // ignore
  }
}

/** Drop process-local L1 — simulates a cold serverless isolate. */
export function clearRuntimeMemory(sessionId?: string): void {
  if (sessionId) {
    memory.delete(sessionId);
    return;
  }
  memory.clear();
}

/**
 * Test / debug helper: run `fn` as if on a fresh isolate (empty L1),
 * while still sharing the injected or Supabase durable store.
 */
export async function withFreshIsolate<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  clearRuntimeMemory(sessionId);
  return fn();
}
