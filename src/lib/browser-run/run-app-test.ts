import { chromium, type Browser } from "playwright-core";

import { getSession } from "@/lib/session/store";
import { isSyntheticHttpPreviewError } from "@/lib/sandbox/preview-errors";
import { checkAppServer } from "@/lib/sandbox/preview";

import {
  createAppTestRunId,
  ensureArtifactDir,
  resolveAppTestArtifactDir,
  writeLiveViewArtifacts,
  writeReportJson,
} from "./artifacts";
import { createBrowserRunSession } from "./client";
import {
  requireBrowserRunConfig,
  shouldPersistAppTestArtifacts,
} from "./config";
import {
  exerciseGenericClicks,
  exerciseListFormFlow,
} from "./interactions";
import {
  acquireAppTestLock,
  releaseAppTestLock,
  statusFromReport,
  writeLatestAppTestStatus,
} from "./run-status";
import { executeScriptedActions } from "./scripted-steps";
import type {
  AppTestReport,
  AppTestStep,
  RunAppTestOptions,
} from "./types";
import { APP_TEST_LIVE_VIEW_LOG_PREFIX } from "./types";

const DEFAULT_HOLD_MS = 12_000;
const DEFAULT_MAX_CLICKS = 3;
/** Keep-alive while idle; keep short to limit billing if close() is missed. */
const DEFAULT_KEEP_ALIVE_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function previewOrigin(previewUrl: string): string {
  return new URL(previewUrl).origin;
}

async function persistStatus(
  sessionId: string,
  status: Parameters<typeof writeLatestAppTestStatus>[1],
  userId: string | null = null,
): Promise<void> {
  await writeLatestAppTestStatus(sessionId, status, userId).catch(() => {});
}

export async function runAppTest(
  options: RunAppTestOptions,
): Promise<AppTestReport> {
  const started = Date.now();
  const runId = createAppTestRunId();
  const steps: AppTestStep[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const screenshots: string[] = [];
  let userId: string | null = null;

  const finish = async (report: AppTestReport): Promise<AppTestReport> => {
    const latest = {
      ...statusFromReport(report),
      startedAt: new Date(started).toISOString(),
    };
    await persistStatus(options.sessionId, latest, userId);
    return report;
  };

  if (!acquireAppTestLock(options.sessionId)) {
    return failReport({
      sessionId: options.sessionId,
      runId,
      started,
      steps,
      consoleErrors,
      pageErrors,
      screenshots,
      error: "An app test is already running for this session",
    });
  }

  try {
  const session = await getSession(options.sessionId);
  if (!session) {
    return finish(
      failReport({
        sessionId: options.sessionId,
        runId,
        started,
        steps,
        consoleErrors,
        pageErrors,
        screenshots,
        error: `Session not found: ${options.sessionId}`,
      }),
    );
  }

  userId = session.userId;

  await persistStatus(
    options.sessionId,
    {
      status: "running",
      runId,
      startedAt: new Date(started).toISOString(),
    },
    userId,
  );

  if (session.sandboxMode !== "daytona") {
    return finish(
      failReport({
        sessionId: options.sessionId,
        runId,
        started,
        steps,
        consoleErrors,
        pageErrors,
        screenshots,
        error:
          "App testing via Cloudflare Browser Run requires sandboxMode=daytona (localhost is not reachable from Cloudflare).",
      }),
    );
  }

  let config;
  try {
    config = requireBrowserRunConfig();
  } catch (error) {
    return finish(
      failReport({
        sessionId: options.sessionId,
        runId,
        started,
        steps,
        consoleErrors,
        pageErrors,
        screenshots,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const preview = await checkAppServer(options.sessionId);
  if (preview.status !== "ready" || !preview.url) {
    return finish(
      failReport({
        sessionId: options.sessionId,
        runId,
        started,
        steps,
        consoleErrors,
        pageErrors,
        screenshots,
        error: `Preview is not ready (status=${preview.status}). Call checkPreview first.`,
        previewUrl: preview.url,
      }),
    );
  }

  if (
    preview.buildError &&
    !isSyntheticHttpPreviewError(preview.buildError)
  ) {
    return finish(
      failReport({
        sessionId: options.sessionId,
        runId,
        started,
        steps,
        consoleErrors,
        pageErrors,
        screenshots,
        error: `Preview has buildError: ${preview.buildError}`,
        previewUrl: preview.url,
      }),
    );
  }

  const previewUrl = preview.url;
  const persistArtifacts =
    Boolean(options.artifactDir) || shouldPersistAppTestArtifacts();
  const artifactDir = persistArtifacts
    ? resolveAppTestArtifactDir(
        options.sessionId,
        runId,
        session.userId,
        options.artifactDir,
      )
    : undefined;
  if (artifactDir) {
    await ensureArtifactDir(artifactDir);
  }

  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  const maxClicks = options.maxClicks ?? DEFAULT_MAX_CLICKS;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

  let browser: Browser | undefined;
  let liveViewUrl: string | undefined;
  let browserSessionId: string | undefined;

  try {
    const cfSession = await createBrowserRunSession(config, keepAliveMs);
    liveViewUrl = cfSession.liveViewUrl;
    browserSessionId = cfSession.browserSessionId;
    steps.push({
      name: "createBrowserSession",
      ok: true,
      detail: browserSessionId,
    });

    if (artifactDir) {
      await writeLiveViewArtifacts(artifactDir, liveViewUrl);
    }

    await persistStatus(
      options.sessionId,
      {
        status: "running",
        runId,
        liveViewUrl,
        artifactDir,
        startedAt: new Date(started).toISOString(),
      },
      userId,
    );

    // Connect CDP immediately so the session stays pinned during hold / Live View.
    browser = await chromium.connectOverCDP(cfSession.webSocketDebuggerUrl, {
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
      },
    });

    await options.onLiveViewReady?.(liveViewUrl);
    console.info(`${APP_TEST_LIVE_VIEW_LOG_PREFIX}${liveViewUrl}`);

    if (holdMs > 0) {
      steps.push({
        name: "holdForMonitor",
        ok: true,
        detail: `${holdMs}ms`,
      });
      await sleep(holdMs);
    }

    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    const origin = previewOrigin(previewUrl);
    await page.goto(previewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Daytona signed preview often shows a "Loading …" interstitial first.
    await page
      .waitForFunction(
        () => {
          const t = document.title || "";
          return t.length > 0 && !t.startsWith("Loading ");
        },
        { timeout: 60_000 },
      )
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    if (options.actions?.length) {
      await page.locator("body").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    } else {
      await page
        .locator(
          'input[placeholder*="Add" i], input[placeholder*="task" i], input[type="text"], textarea, button',
        )
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .catch(() => {});
    }
    await sleep(1_500);

    const title = await page.title().catch(() => "");
    steps.push({
      name: "gotoPreview",
      ok: Boolean(title) && !title.startsWith("Loading "),
      detail: title || previewUrl,
    });

    if (!title || title.startsWith("Loading ")) {
      const report = failReport({
        sessionId: options.sessionId,
        runId,
        started,
        steps,
        consoleErrors,
        pageErrors,
        screenshots,
        error: `Preview still on Daytona loading page (title=${title || "empty"}). Try again when sandbox preview is warm.`,
        previewUrl,
        liveViewUrl,
        browserSessionId,
        artifactDir,
      });
      if (artifactDir) {
        await writeReportJson(artifactDir, report).catch(() => {});
      }
      return finish(report);
    }

    if (artifactDir) {
      try {
        await page.locator("body").screenshot({
          path: `${artifactDir}/01-home.png`,
          timeout: 10_000,
          animations: "disabled",
        });
        screenshots.push(`${artifactDir}/01-home.png`);
      } catch (error) {
        steps.push({
          name: "screenshot:home",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const scripted = options.actions?.length
      ? options.actions
      : undefined;
    let usedScriptedActions = false;
    let scriptedOk = true;
    let clickCount = 0;
    let formExercised = false;
    let formAddOk = false;
    let formDeleteOk = false;

    if (scripted) {
      usedScriptedActions = true;
      const result = await executeScriptedActions(
        page,
        scripted,
        artifactDir,
        steps,
        screenshots,
      );
      scriptedOk = result.ok;
      steps.push({
        name: "scriptedActions",
        ok: result.ok,
        detail: `${result.completed}/${scripted.length} completed`,
      });
    } else {
      const form = await exerciseListFormFlow(
        page,
        artifactDir,
        steps,
        screenshots,
      );
      formExercised = form.exercised;
      formAddOk = form.addOk;
      formDeleteOk = form.deleteOk;

      // Light CTA pass only when no form was found (avoid noisy same-page clicks).
      if (!form.exercised) {
        clickCount = await exerciseGenericClicks(
          page,
          previewUrl,
          origin,
          artifactDir,
          maxClicks,
          steps,
          screenshots,
        );
      }
    }

    const seriousConsole = consoleErrors.filter(
      (line) => !/Download the React DevTools/i.test(line),
    );
    const gotoOk = steps.some((s) => s.name === "gotoPreview" && s.ok);
    const formOk = !formExercised || formAddOk;
    const finalOk =
      gotoOk &&
      pageErrors.length === 0 &&
      (usedScriptedActions ? scriptedOk : formOk);

    let summary: string;
    if (!finalOk) {
      if (pageErrors.length > 0) {
        summary = `Page errors: ${pageErrors[0]}`;
      } else if (usedScriptedActions && !scriptedOk) {
        summary = "Scripted selector steps failed — see report steps.";
      } else if (formExercised && !formAddOk) {
        summary = "Form add failed — item not visible after submit.";
      } else {
        summary = "Failed to load or exercise preview.";
      }
    } else if (usedScriptedActions) {
      summary = `Preview loaded; ran ${scripted!.length} scripted step(s).`;
      if (seriousConsole.length > 0) {
        summary += ` (${seriousConsole.length} console error(s) — review report)`;
      }
    } else if (formExercised) {
      summary = formDeleteOk
        ? "Preview loaded; added and deleted a list item."
        : "Preview loaded; added a list item (delete not confirmed).";
      if (seriousConsole.length > 0) {
        summary += ` (${seriousConsole.length} console error(s) — review report)`;
      }
    } else {
      summary = `Preview loaded${clickCount > 0 ? `; exercised ${clickCount} control(s)` : ""}.`;
      if (seriousConsole.length > 0) {
        summary += ` (${seriousConsole.length} console error(s) — review report)`;
      }
    }

    const report: AppTestReport = {
      ok: finalOk,
      summary,
      sessionId: options.sessionId,
      runId,
      previewUrl,
      liveViewUrl,
      browserSessionId,
      steps,
      consoleErrors: seriousConsole,
      pageErrors,
      screenshots,
      artifactDir,
      durationMs: Date.now() - started,
      usedScriptedActions,
    };

    if (artifactDir) {
      await writeReportJson(artifactDir, report);
    }
    return finish(report);
  } catch (error) {
    const report = failReport({
      sessionId: options.sessionId,
      runId,
      started,
      steps,
      consoleErrors,
      pageErrors,
      screenshots,
      error: error instanceof Error ? error.message : String(error),
      previewUrl,
      liveViewUrl,
      browserSessionId,
      artifactDir,
    });
    if (artifactDir) {
      await writeReportJson(artifactDir, report).catch(() => {});
    }
    return finish(report);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
  } finally {
    releaseAppTestLock(options.sessionId);
  }
}

function failReport(args: {
  sessionId: string;
  runId: string;
  started: number;
  steps: AppTestStep[];
  consoleErrors: string[];
  pageErrors: string[];
  screenshots: string[];
  error: string;
  previewUrl?: string;
  liveViewUrl?: string;
  browserSessionId?: string;
  artifactDir?: string;
}): AppTestReport {
  return {
    ok: false,
    summary: args.error,
    sessionId: args.sessionId,
    runId: args.runId,
    previewUrl: args.previewUrl,
    liveViewUrl: args.liveViewUrl,
    browserSessionId: args.browserSessionId,
    steps: args.steps,
    consoleErrors: args.consoleErrors,
    pageErrors: args.pageErrors,
    screenshots: args.screenshots,
    artifactDir: args.artifactDir,
    durationMs: Date.now() - args.started,
    error: args.error,
  };
}

export { APP_TEST_LIVE_VIEW_LOG_PREFIX };
