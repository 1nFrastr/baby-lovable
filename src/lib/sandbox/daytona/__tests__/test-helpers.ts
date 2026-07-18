/**
 * Shared helpers for Daytona runtime race tests.
 *
 * Model: each "isolate" has an empty process L1 cache but shares the durable
 * session file store — same as distinct Vercel/Workflow isolates.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "vitest";

import type { Session } from "@/lib/session/types";
import { SESSION_SCHEMA_VERSION } from "@/lib/session/types";
import { clearRuntimeMemory } from "@/lib/sandbox/daytona/runtime-store";

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
    sandboxMode: "daytona",
  };
}

export async function withTempDataDir<T>(
  fn: (ctx: { dataDir: string; sessionId: string }) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-runtime-"));
  const sessionId = `sess_race_${Date.now().toString(36)}`;
  const prevDataDir = process.env.BABY_LOVABLE_DATA_DIR;
  const prevLocal = process.env.BABY_LOVABLE_LOCAL_MODE;

  process.env.BABY_LOVABLE_DATA_DIR = dataDir;
  process.env.BABY_LOVABLE_LOCAL_MODE = "1";
  clearRuntimeMemory();

  try {
    // Ensure session.json exists for getSession() in store paths.
    const sessionRoot = path.join(dataDir, "sessions", sessionId);
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.writeFile(
      path.join(sessionRoot, "session.json"),
      `${JSON.stringify(makeSession(sessionId), null, 2)}\n`,
      "utf8",
    );

    return await fn({ dataDir, sessionId });
  } finally {
    clearRuntimeMemory();
    if (prevDataDir === undefined) {
      delete process.env.BABY_LOVABLE_DATA_DIR;
    } else {
      process.env.BABY_LOVABLE_DATA_DIR = prevDataDir;
    }
    if (prevLocal === undefined) {
      delete process.env.BABY_LOVABLE_LOCAL_MODE;
    } else {
      process.env.BABY_LOVABLE_LOCAL_MODE = prevLocal;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

/** Drop L1 — cold start a new serverless isolate in-process. */
export function enterIsolate(sessionId: string): void {
  clearRuntimeMemory(sessionId);
}

/**
 * Use beforeEach/afterEach when tests need a temp data dir without nesting
 * the whole body in withTempDataDir.
 */
export function useTempRuntimeEnv(): {
  getSessionId: () => string;
  getDataDir: () => string;
} {
  let dataDir = "";
  let sessionId = "";
  let prevDataDir: string | undefined;
  let prevLocal: string | undefined;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-runtime-"));
    sessionId = `sess_race_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    prevDataDir = process.env.BABY_LOVABLE_DATA_DIR;
    prevLocal = process.env.BABY_LOVABLE_LOCAL_MODE;
    process.env.BABY_LOVABLE_DATA_DIR = dataDir;
    process.env.BABY_LOVABLE_LOCAL_MODE = "1";
    clearRuntimeMemory();

    const sessionRoot = path.join(dataDir, "sessions", sessionId);
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.writeFile(
      path.join(sessionRoot, "session.json"),
      `${JSON.stringify(makeSession(sessionId), null, 2)}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    clearRuntimeMemory();
    if (prevDataDir === undefined) {
      delete process.env.BABY_LOVABLE_DATA_DIR;
    } else {
      process.env.BABY_LOVABLE_DATA_DIR = prevDataDir;
    }
    if (prevLocal === undefined) {
      delete process.env.BABY_LOVABLE_LOCAL_MODE;
    } else {
      process.env.BABY_LOVABLE_LOCAL_MODE = prevLocal;
    }
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  return {
    getSessionId: () => sessionId,
    getDataDir: () => dataDir,
  };
}
