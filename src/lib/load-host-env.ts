import { loadEnvConfig } from "@next/env";

/**
 * Side-effect import first in CLI entrypoints so `.env.local` is loaded before
 * any module that reads `process.env`:
 *
 *   import "@/lib/load-host-env";
 *
 * Always pass `dev: true` so `.env.local` is picked up (a missing `dev` flag
 * makes `@next/env` treat the process as production).
 */
loadEnvConfig(process.cwd(), true);

/** Idempotent re-load (usually unnecessary after the side-effect import). */
export function loadHostEnv(dir: string = process.cwd()): void {
  loadEnvConfig(dir, true);
}
