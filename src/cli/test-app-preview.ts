import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  APP_TEST_LIVE_VIEW_LOG_PREFIX,
  parseAppTestActions,
  runAppTest,
  type AppTestAction,
} from "@/lib/browser-run";
import { startDaytonaPreview } from "@/lib/sandbox/daytona/app-server";
import { checkAppServer } from "@/lib/sandbox/preview";
import { getSession } from "@/lib/session/store";

function printUsage(): void {
  console.log(`Usage:
  npm run test:app-preview -- -s <sessionId> [options]

Options:
  -s, --session <id>   Session id (required; must be daytona)
  --steps <file.json>  Scripted Playwright steps (JSON array). Skips heuristics.
  --steps-json <json>  Inline JSON array of steps (same schema as --steps)
  --hold-ms <n>        Wait after Live View URL before automation (default 12000)
  --max-clicks <n>     Max CTA clicks in heuristic mode (default 3)
  --bootstrap          Kick Daytona preview bootstrap and wait until ready
  -h, --help           Show help

Step schema (each item):
  { "action": "fill"|"click"|"press"|"hover"|"assertVisible"|"assertHidden"|"wait"|"screenshot",
    "selector"?: string, "text"?: string, "value"?: string, "key"?: string,
    "ms"?: number, "name"?: string }
  Placeholders in selector/text/value: {{unique}} or {{now}}

Example:
  npm run test:app-preview -- -s sess_xxx --steps examples/app-test-todo-steps.json --hold-ms 0

After the Cloudflare session starts, open the printed Live View URL (or
app-tests/<runId>/monitor.html) in a browser to watch the remote Chrome.
`);
}

async function loadActionsFromFile(filePath: string): Promise<AppTestAction[]> {
  const abs = path.resolve(filePath);
  const raw = await readFile(abs, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${abs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseAppTestActions(json);
}

function loadActionsFromInline(jsonText: string): AppTestAction[] {
  let json: unknown;
  try {
    json = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid --steps-json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseAppTestActions(json);
}

function parseArgs(argv: string[]) {
  let sessionId: string | undefined;
  let holdMs = 12_000;
  let maxClicks = 3;
  let bootstrap = false;
  let stepsFile: string | undefined;
  let stepsJson: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "-s" || arg === "--session") {
      sessionId = argv[++i];
      continue;
    }
    if (arg === "--hold-ms") {
      holdMs = Number(argv[++i]);
      continue;
    }
    if (arg === "--max-clicks") {
      maxClicks = Number(argv[++i]);
      continue;
    }
    if (arg === "--bootstrap") {
      bootstrap = true;
      continue;
    }
    if (arg === "--steps") {
      stepsFile = argv[++i];
      continue;
    }
    if (arg === "--steps-json") {
      stepsJson = argv[++i];
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown flag: ${arg}`);
      printUsage();
      process.exit(1);
    }
    // positional session id fallback
    if (!sessionId) {
      sessionId = arg;
    }
  }

  if (!sessionId) {
    printUsage();
    process.exit(1);
  }

  if (!Number.isFinite(holdMs) || holdMs < 0) {
    console.error("--hold-ms must be a non-negative number");
    process.exit(1);
  }
  if (!Number.isFinite(maxClicks) || maxClicks < 0) {
    console.error("--max-clicks must be a non-negative number");
    process.exit(1);
  }
  if (stepsFile && stepsJson) {
    console.error("Use only one of --steps or --steps-json");
    process.exit(1);
  }

  return { sessionId, holdMs, maxClicks, bootstrap, stepsFile, stepsJson };
}

async function waitForPreviewReady(sessionId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = await checkAppServer(sessionId);
    if (report.status === "ready" && report.url) {
      return report;
    }
    if (report.status === "error") {
      throw new Error(`Preview error while waiting: ${report.buildError ?? "unknown"}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error("Timed out waiting for Daytona preview to become ready");
}

async function main() {
  const { sessionId, holdMs, maxClicks, bootstrap, stepsFile, stepsJson } =
    parseArgs(process.argv.slice(2));

  let actions: AppTestAction[] | undefined;
  if (stepsFile) {
    actions = await loadActionsFromFile(stepsFile);
  } else if (stepsJson) {
    actions = loadActionsFromInline(stepsJson);
  }

  const session = await getSession(sessionId);
  if (!session) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }
  if (session.sandboxMode !== "daytona") {
    console.error(
      `Session ${sessionId} is sandboxMode=${session.sandboxMode}. App testing requires daytona.`,
    );
    process.exit(1);
  }

  if (bootstrap) {
    console.log("Bootstrapping Daytona preview…");
    startDaytonaPreview(sessionId);
    await waitForPreviewReady(sessionId);
    console.log("Preview ready.");
  }

  console.log(
    `Running app test for ${sessionId} (hold=${holdMs}ms${actions ? `, scripted=${actions.length} steps` : ", mode=heuristic"})…`,
  );
  console.log(
    "When Live View URL appears, open it in a browser within ~5 minutes to monitor.",
  );

  const report = await runAppTest({
    sessionId,
    holdMs,
    maxClicks,
    actions,
    onLiveViewReady: async (liveViewUrl) => {
      console.log("");
      console.log("═".repeat(72));
      console.log("Live View (open in browser):");
      console.log(liveViewUrl);
      console.log("═".repeat(72));
      console.log(`Also greppable: ${APP_TEST_LIVE_VIEW_LOG_PREFIX}${liveViewUrl}`);
      console.log(`Holding ${holdMs}ms for you to open the monitor…`);
      console.log("");
    },
  });

  if (report.artifactDir) {
    console.log(`Artifacts: ${path.resolve(report.artifactDir)}`);
    console.log(`  monitor: ${path.join(report.artifactDir, "monitor.html")}`);
    console.log(`  report:  ${path.join(report.artifactDir, "report.json")}`);
  }

  console.log("");
  console.log(JSON.stringify({
    ok: report.ok,
    summary: report.summary,
    usedScriptedActions: report.usedScriptedActions ?? false,
    liveViewUrl: report.liveViewUrl,
    previewUrl: report.previewUrl,
    durationMs: report.durationMs,
    consoleErrors: report.consoleErrors.length,
    pageErrors: report.pageErrors.length,
    steps: report.steps.length,
    screenshots: report.screenshots.length,
    error: report.error,
  }, null, 2));

  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
