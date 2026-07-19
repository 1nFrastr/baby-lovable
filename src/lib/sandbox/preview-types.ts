/**
 * Three layers (bottom → top):
 *   1. sandbox   — VM / local workspace
 *   2. appServer — pnpm install + pnpm dev
 *   3. previewUrl — URL the browser can open
 *
 * Read with getXxxStatus. Change with start / stop / restart / delete.
 */

/** Layer 1 */
export type SandboxStatus =
  | "missing"
  | "stopped"
  | "starting"
  | "running"
  | "error";

/** Layer 2 */
export type AppServerStatus =
  | { status: "installing"; url?: string }
  | { status: "needs_install" }
  | { status: "starting"; port: number; url?: string }
  | { status: "ready"; url: string; port: number }
  | { status: "error"; error: string }
  | { status: "stopped" };

/** Layer 3 */
export type PreviewUrlStatus =
  | { status: "none" }
  | { status: "ready"; url: string };

/** All three layers (UI poll / session load). Read-only. */
export interface AllStatus {
  sandbox: SandboxStatus;
  appServer: AppServerStatus;
  previewUrl: PreviewUrlStatus;
}

/** checkAppServer result: status + HTTP + compile error */
export interface AppServerCheck {
  status: AppServerStatus["status"];
  url?: string;
  httpStatus?: number;
  buildError: string | null;
}
