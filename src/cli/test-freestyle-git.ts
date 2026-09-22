/**
 * Real sandbox + Freestyle end-to-end smoke (Vercel or Daytona):
 *   provision repo → create sandbox → hydrate → mutate → commit/push → re-hydrate
 *
 * Usage:
 *   npx tsx src/cli/test-freestyle-git.ts
 *   SANDBOX_PROVIDER=vercel npx tsx src/cli/test-freestyle-git.ts
 *   npx tsx src/cli/test-freestyle-git.ts --keep
 */
import "@/lib/load-host-env";

import { assertFreestyleForDaytona } from "@/lib/git/freestyle-config";
import { ensureFreestyleRepository } from "@/lib/git/provision-repo";
import { hydrateWorkspaceFromFreestyle } from "@/lib/git/hydrate-workspace";
import { readGitRepository } from "@/lib/git/repository-store";
import {
  enqueueTurnCheckpoint,
  runTurnCheckpoint,
} from "@/lib/git/turn-sync";
import { isDaytonaConfigured } from "@/lib/sandbox/daytona/config";
import { ensureDesiredState } from "@/lib/sandbox/daytona/runtime-reconciler";
import { getRuntimeSnapshot } from "@/lib/sandbox/daytona/runtime-store";
import { getProjectSandbox } from "@/lib/sandbox/factory";
import { getSandboxDriverForSession } from "@/lib/sandbox/providers";
import { getDefaultSandboxMode } from "@/lib/sandbox/types";
import { isVercelSandboxConfigured } from "@/lib/sandbox/vercel/config";
import { createSession, updateSession } from "@/lib/session/store";

const keep = process.argv.includes("--keep");

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${tag.padEnd(10)} ${msg}`);
}

function fail(msg: string): never {
  log("FAIL", msg);
  process.exit(1);
}

async function main() {
  const mode = getDefaultSandboxMode();
  if (mode === "vercel" && !isVercelSandboxConfigured()) {
    fail("Vercel Sandbox is not configured");
  }
  if (mode === "daytona" && !isDaytonaConfigured()) {
    fail("DAYTONA_API_KEY not configured");
  }
  assertFreestyleForDaytona(mode);

  log("START", `create ${mode} session …`);
  const session = await createSession({
    title: "Freestyle Git smoke",
  });
  log("SESSION", session.id);

  try {
    log("REPO", "ensure Freestyle repository …");
    const repo = await ensureFreestyleRepository(session.id, session.userId);
    if (!repo.repoId || !repo.remoteUrl || !repo.identityId) {
      fail("Freestyle binding incomplete");
    }
    log("REPO", `id=${repo.repoId.slice(0, 12)}… branch=${repo.defaultBranch}`);

    log("SANDBOX", "ensure sandbox-ready (create + hydrate) …");
    const snap = await ensureDesiredState(session.id, "sandbox-ready", {
      wait: true,
    });
    log(
      "SANDBOX",
      `observed=${snap.observed} sandboxId=${snap.sandboxId?.slice(0, 12) ?? "none"}`,
    );
    if (snap.observed === "error") {
      fail(snap.lastError ?? "sandbox ready failed");
    }

    log("HYDRATE", "wait for Freestyle pull …");
    const hydrateDeadline = Date.now() + 120_000;
    let afterHydrate = await readGitRepository(session.id, session.userId);
    while (Date.now() < hydrateDeadline) {
      afterHydrate = await readGitRepository(session.id, session.userId);
      if (afterHydrate?.provisionStatus === "ready") {
        break;
      }
      if (afterHydrate?.provisionStatus === "error") {
        fail(
          `hydrate failed: ${afterHydrate.provisionError ?? "unknown"}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (afterHydrate?.provisionStatus !== "ready") {
      const project = await getProjectSandbox(session.id);
      const explicit = await hydrateWorkspaceFromFreestyle(
        session.id,
        project,
        session.userId,
      );
      if (!explicit.ok) {
        fail(`hydrate not ready: ${explicit.error ?? explicit.mode}`);
      }
      afterHydrate = await readGitRepository(session.id, session.userId);
    }
    if (afterHydrate?.provisionStatus !== "ready") {
      fail(
        `hydrate not ready: ${afterHydrate?.provisionStatus} ${afterHydrate?.provisionError ?? ""}`,
      );
    }
    log(
      "HYDRATE",
      `ready sha=${afterHydrate.remoteHeadSha?.slice(0, 7) ?? "(none yet)"}`,
    );

    const project = await getProjectSandbox(session.id);
    if (!project.git) {
      fail("sandbox missing git runner");
    }

    const page = await project.fs.readTextFile("src/app/page.tsx");
    if (!page.includes("function")) {
      fail("read src/app/page.tsx after hydrate returned unexpected content");
    }
    log("READ", `src/app/page.tsx bytes=${page.length}`);

    const stamp = new Date().toISOString();
    const markerPath = "src/app/freestyle-smoke.txt";
    await project.fs.writeTextFile(markerPath, `freestyle smoke ${stamp}\n`);
    log("MUTATE", `wrote ${markerPath}`);

    const runId = `smoke_${Date.now()}`;
    await enqueueTurnCheckpoint({
      sessionId: session.id,
      runId,
      outcome: "completed",
      commitMessage: `turn-smoke: freestyle e2e\n\nSession: ${session.id}\nRun: ${runId}\nOutcome: completed`,
      userId: session.userId,
    });

    log("SYNC", "commit + push …");
    const task = await runTurnCheckpoint(
      session.id,
      runId,
      project,
      session.userId,
    );
    log("SYNC", `status=${task.status} sha=${task.localCommitSha?.slice(0, 7) ?? "n/a"}`);
    if (task.status !== "synced") {
      fail(`checkpoint failed: ${task.status} ${task.lastError ?? ""}`);
    }

    const synced = await readGitRepository(session.id, session.userId);
    if (synced?.remoteHeadSha !== task.localCommitSha) {
      fail("remoteHeadSha mismatch after sync");
    }

    log("REHYDRATE", "pull existing Freestyle main …");
    const again = await hydrateWorkspaceFromFreestyle(
      session.id,
      project,
      session.userId,
    );
    if (!again.ok) {
      fail(`rehydrate failed: ${again.error ?? again.mode}`);
    }
    const content = await project.fs.readTextFile(markerPath);
    if (!content.includes(stamp)) {
      fail("marker file missing after rehydrate");
    }
    log("REHYDRATE", `ok mode=${again.mode}`);

    log("PASS", `${mode} + Freestyle e2e succeeded`);
  } finally {
    if (!keep) {
      try {
        log("CLEANUP", "delete sandbox …");
        const snap = await getRuntimeSnapshot(session.id, session.userId, {
          fresh: true,
        });
        if (snap.sandboxId) {
          const driver = await getSandboxDriverForSession(session.id);
          await driver.deleteById(session.id, snap.sandboxId);
        }
      } catch (error) {
        log(
          "WARN",
          `sandbox delete: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await updateSession(session.id, {
          deletedAt: new Date().toISOString(),
        });
        log("CLEANUP", "session soft-deleted (Freestyle repo retained)");
      } catch (error) {
        log(
          "WARN",
          `session delete: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      log("KEEP", `session=${session.id} sandbox retained`);
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
