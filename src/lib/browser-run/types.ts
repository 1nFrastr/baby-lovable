export interface AppTestStep {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Caller-supplied automation step (Builder Agent / CLI). Playwright selectors. */
export type AppTestActionType =
  | "fill"
  | "click"
  | "press"
  | "hover"
  | "assertVisible"
  | "assertHidden"
  | "wait"
  | "screenshot";

export interface AppTestAction {
  action: AppTestActionType;
  /** Playwright locator string, e.g. `input[placeholder="Add a task"]`. Supports `{{unique}}`. */
  selector?: string;
  /** For assertVisible / assertHidden via text match. Supports `{{unique}}`. */
  text?: string;
  /** For fill. Supports `{{unique}}` / `{{now}}` placeholders. */
  value?: string;
  /** For press (default Enter). */
  key?: string;
  /** For wait. */
  ms?: number;
  /** Per-step timeout (default 8000). */
  timeoutMs?: number;
  /** Extra settle after fill/click/press before auto-screenshot (default 400). */
  settleMs?: number;
  /** Optional label in the report. */
  name?: string;
  /** For screenshot: absolute or artifact-relative path override. */
  path?: string;
  /** Continue the script after this step fails. */
  continueOnError?: boolean;
}

export interface AppTestReport {
  ok: boolean;
  summary: string;
  sessionId: string;
  runId: string;
  previewUrl?: string;
  /** Cloudflare Live View URL — open in a browser to monitor the remote Chrome. */
  liveViewUrl?: string;
  /** Cloudflare Browser Run session id. */
  browserSessionId?: string;
  steps: AppTestStep[];
  consoleErrors: string[];
  pageErrors: string[];
  screenshots: string[];
  artifactDir?: string;
  durationMs: number;
  error?: string;
  /** True when caller-supplied actions were used instead of heuristics. */
  usedScriptedActions?: boolean;
}

export interface RunAppTestOptions {
  sessionId: string;
  /** Wait after Live View URL is ready so a human can open the monitor. Default 12000. */
  holdMs?: number;
  /** Max primary CTA clicks (heuristic mode only). Default 3. */
  maxClicks?: number;
  /** Keep-alive for the CF browser session in ms. Default 120000. */
  keepAliveMs?: number;
  /**
   * Explicit Playwright steps from Builder Agent / CLI.
   * When non-empty, heuristic form/CTA discovery is skipped.
   */
  actions?: AppTestAction[];
  /** Called as soon as the Live View URL is available (before hold / navigation). */
  onLiveViewReady?: (liveViewUrl: string) => void | Promise<void>;
  /** Override artifact root; defaults to session `app-tests/<runId>/`. */
  artifactDir?: string;
}

export const APP_TEST_LIVE_VIEW_LOG_PREFIX = "[app-test] LIVE_VIEW=";
