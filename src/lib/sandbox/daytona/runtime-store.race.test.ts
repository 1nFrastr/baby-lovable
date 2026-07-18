/**
 * Serverless isolate simulation for runtime-store.
 *
 * Two "isolates" share durable `daytona-runtime.json` but each call to
 * enterIsolate() clears process L1 — matching cold Vercel/Workflow workers.
 */

import { describe, expect, it } from "vitest";

import {
  acquireRuntimeLease,
  clearRuntimeSnapshot,
  getRuntimeSnapshot,
  releaseRuntimeLease,
  renewRuntimeLease,
  upsertRuntimeSnapshot,
  withFreshIsolate,
} from "./runtime-store";
import { enterIsolate, withTempDataDir } from "./__tests__/test-helpers";

describe("runtime-store serverless isolate races", () => {
  it("stale L1 cannot clobber a newer durable write from another isolate", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      // Isolate A seeds durable state
      await upsertRuntimeSnapshot(sessionId, {
        desired: "sandbox-ready",
        observed: "workspace-ready",
        sandboxId: "sb_a",
      });

      // Isolate A keeps a stale L1 copy in this process… then Isolate B writes.
      const staleFromA = await getRuntimeSnapshot(sessionId);
      expect(staleFromA.revision).toBe(1);

      await withFreshIsolate(sessionId, async () => {
        await upsertRuntimeSnapshot(sessionId, {
          expectedRevision: 1,
          desired: "preview-ready",
          observed: "starting-devserver",
          sandboxId: "sb_a",
        });
      });

      // Isolate A tries to write from stale revision → CAS fail
      await expect(
        upsertRuntimeSnapshot(sessionId, {
          expectedRevision: staleFromA.revision,
          desired: "stopped",
        }),
      ).rejects.toThrow(/CAS conflict/);

      // Fresh isolate sees B's desired state, not A's attempted stop
      enterIsolate(sessionId);
      const durable = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      expect(durable.desired).toBe("preview-ready");
      expect(durable.observed).toBe("starting-devserver");
      expect(durable.revision).toBe(2);
    });
  });

  it("parallel create from two cold isolates: only one create wins", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      enterIsolate(sessionId);
      const results = await Promise.allSettled([
        withFreshIsolate(sessionId, () =>
          upsertRuntimeSnapshot(sessionId, {
            desired: "sandbox-ready",
            observed: "creating-sandbox",
            sandboxId: "sb_1",
          }),
        ),
        withFreshIsolate(sessionId, () =>
          upsertRuntimeSnapshot(sessionId, {
            desired: "sandbox-ready",
            observed: "creating-sandbox",
            sandboxId: "sb_2",
          }),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      enterIsolate(sessionId);
      const final = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      expect(final.revision).toBe(1);
      expect(["sb_1", "sb_2"]).toContain(final.sandboxId);
    });
  });

  it("lease: second isolate cannot acquire while first holds it", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      const a = await withFreshIsolate(sessionId, () =>
        acquireRuntimeLease(sessionId, "isolate-A", 5_000),
      );
      expect(a?.leaseOwner).toBe("isolate-A");

      const b = await withFreshIsolate(sessionId, () =>
        acquireRuntimeLease(sessionId, "isolate-B", 5_000),
      );
      expect(b).toBeNull();

      await withFreshIsolate(sessionId, () =>
        releaseRuntimeLease(sessionId, "isolate-A"),
      );

      const b2 = await withFreshIsolate(sessionId, () =>
        acquireRuntimeLease(sessionId, "isolate-B", 5_000),
      );
      expect(b2?.leaseOwner).toBe("isolate-B");
    });
  });

  it("lease: expired lease can be stolen by another isolate", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      await withFreshIsolate(sessionId, () =>
        acquireRuntimeLease(sessionId, "isolate-A", 40),
      );

      await new Promise((r) => setTimeout(r, 60));

      const stolen = await withFreshIsolate(sessionId, () =>
        acquireRuntimeLease(sessionId, "isolate-B", 5_000),
      );
      expect(stolen?.leaseOwner).toBe("isolate-B");
    });
  });

  it("lease renew fails for non-owner isolate", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      await withFreshIsolate(sessionId, () =>
        acquireRuntimeLease(sessionId, "isolate-A", 5_000),
      );

      const renewed = await withFreshIsolate(sessionId, () =>
        renewRuntimeLease(sessionId, "isolate-B", 5_000),
      );
      expect(renewed).toBeNull();
    });
  });

  it("webui poll isolate sees writer isolate progress via durable store", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      // Agent / startPreview isolate
      await withFreshIsolate(sessionId, async () => {
        await upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "creating-sandbox",
        });
        await upsertRuntimeSnapshot(sessionId, {
          expectedRevision: 1,
          observed: "bootstrapping-workspace",
          sandboxId: "sb_live",
        });
        await upsertRuntimeSnapshot(sessionId, {
          expectedRevision: 2,
          observed: "preview-ready",
          previewUrl: "https://preview.example/embed",
          previewPort: 3000,
        });
      });

      // UI poll isolate (GET /preview) — cold L1
      const polled = await withFreshIsolate(sessionId, () =>
        getRuntimeSnapshot(sessionId, null, { fresh: true }),
      );
      expect(polled.desired).toBe("preview-ready");
      expect(polled.observed).toBe("preview-ready");
      expect(polled.previewUrl).toBe("https://preview.example/embed");
      expect(polled.sandboxId).toBe("sb_live");
    });
  });

  it("stop desired from UI isolate overrides in-flight start desired", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "starting-devserver",
          sandboxId: "sb_1",
          generation: 1,
        }),
      );

      // User hits Stop in another isolate while start is in-flight
      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          expectedRevision: 1,
          desired: "stopped",
          generation: 2,
        }),
      );

      const final = await withFreshIsolate(sessionId, () =>
        getRuntimeSnapshot(sessionId, null, { fresh: true }),
      );
      expect(final.desired).toBe("stopped");
      expect(final.generation).toBe(2);
    });
  });

  it("clearRuntimeSnapshot removes durable file for delete path", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      await upsertRuntimeSnapshot(sessionId, {
        desired: "sandbox-ready",
        sandboxId: "sb_1",
        observed: "workspace-ready",
      });
      await clearRuntimeSnapshot(sessionId);

      enterIsolate(sessionId);
      const again = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      expect(again.revision).toBe(0);
      expect(again.sandboxId).toBeNull();
      expect(again.desired).toBe("stopped");
    });
  });
});
