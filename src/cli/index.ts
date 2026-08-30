import "@/lib/load-host-env";

import { createInterface } from "node:readline/promises";

import { generateId, type UIMessage } from "ai";

import { finalizeInterruptedMessages } from "@/lib/chat/interrupt-assistant";
import { repairUiMessages } from "@/lib/chat/repair-messages";
import {
  replaceMessages,
  createSession,
  deriveSessionTitle,
  getSession,
  listSessions,
  updateSession,
} from "@/lib/session/store";
import { isDaytonaConfigured } from "@/lib/sandbox/daytona/config";
import type { Session } from "@/lib/session/types";
import { assertFreestyleForDaytona } from "@/lib/git/freestyle-config";
import {
  assertSupabaseMetadataConfigured,
  getDevUserId,
} from "@/lib/supabase/config";

import { logger } from "./logger";
import { runAgentTurn } from "./run-agent";
import { printResumeTestResult, runResumeStreamTest } from "./test-resume";

interface CliArgs {
  prompt?: string;
  sessionId?: string;
  maxSteps: number;
  list: boolean;
  help: boolean;
  testResume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    maxSteps: 30,
    list: false,
    help: false,
    testResume: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-p":
      case "--prompt":
        args.prompt = argv[++i];
        break;
      case "-s":
      case "--session":
        args.sessionId = argv[++i];
        break;
      case "--sandbox":
        throw new Error(
          `--sandbox has been removed; Daytona + Freestyle is always used (received ${argv[++i] ?? "no mode"}).`,
        );
      case "--max-steps":
        args.maxSteps = Number(argv[++i]) || 30;
        break;
      case "--list":
      case "-l":
        args.list = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--test-resume":
        args.testResume = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          positional.push(arg);
        }
        break;
    }
  }

  if (!args.prompt && positional.length > 0) {
    args.prompt = positional.join(" ");
  }

  return args;
}

function printHelp(): void {
  logger.raw(
    `\nbaby-lovable agent CLI — run the builder agent from the terminal.\n\n` +
      `Usage:\n` +
      `  npm run agent -- [options] ["your prompt"]\n\n` +
      `Options:\n` +
      `  -p, --prompt <text>    Run a single prompt then exit (one-shot mode)\n` +
      `  -s, --session <id>     Reuse an existing session (keeps history + workspace)\n` +
      `      --max-steps <n>    Max agent steps per turn (default: 30)\n` +
      `  -l, --list             List existing sessions and exit\n` +
      `  -h, --help             Show this help\n` +
      `      --test-resume      Run headless stream-resume test and exit\n\n` +
      `Examples:\n` +
      `  npm run agent -- -p "Create a todo app"\n` +
      `  npm run agent -- --session sess_abc123 -p "Add a gradient to the title"\n` +
      `  npm run agent            # interactive REPL (new session)\n` +
      `  npm run agent -- -s sess_abc123   # interactive REPL on an existing session\n\n`,
  );
}

async function printSessions(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    logger.info("No sessions found yet.");
    return;
  }
  logger.info(`${sessions.length} session(s):`);
  for (const s of sessions) {
    logger.raw(
      `  ${s.id}  ·  ${s.updatedAt.slice(0, 19).replace("T", " ")}  ·  ${s.title}\n`,
    );
  }
}

function requireGatewayKey(): void {
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
    logger.error(
      "Missing AI_GATEWAY_API_KEY. Set it in .env.local (see https://vercel.com/ai-gateway).",
    );
    process.exit(1);
  }
}

function requireRemoteWorkspaceConfig(): void {
  try {
    assertSupabaseMetadataConfigured();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (!getDevUserId()) {
    logger.error(
      "Missing BABY_LOVABLE_DEV_USER_ID. Set it to a real Supabase auth.users.id for CLI access.",
    );
    process.exit(1);
  }
  if (!isDaytonaConfigured()) {
    logger.error(
      "Missing DAYTONA_API_KEY. Set it in .env.local.",
    );
    process.exit(1);
  }
  try {
    assertFreestyleForDaytona();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function resolveSession(args: CliArgs): Promise<Session> {
  if (args.sessionId) {
    const existing = await getSession(args.sessionId);
    if (!existing) {
      logger.error(`Session not found: ${args.sessionId}`);
      process.exit(1);
    }
    logger.info(`Resumed session ${existing.id} (${existing.messages.length} messages)`);
    return existing;
  }

  const session = await createSession();
  logger.info(`Created session ${session.id}`);
  return session;
}

async function runTurn(
  session: Session,
  text: string,
  maxSteps: number,
): Promise<UIMessage[]> {
  const userMessage: UIMessage = {
    id: generateId(),
    role: "user",
    parts: [{ type: "text", text }],
  };

  const messages = repairUiMessages(
    finalizeInterruptedMessages([...session.messages, userMessage]),
  );

  const { assistantMessage } = await runAgentTurn({
    sessionId: session.id,
    messages,
    maxSteps,
  });

  const mergedMessages = assistantMessage
    ? [...messages, assistantMessage]
    : messages;

  await replaceMessages(session.id, mergedMessages);

  if (session.title === "New Project") {
    const title = deriveSessionTitle(mergedMessages);
    if (title) {
      await updateSession(session.id, { title });
      session.title = title;
    }
  }

  session.messages = mergedMessages;

  const { checkpointSessionTurn } = await import(
    "@/lib/git/checkpoint-session-turn"
  );
  await checkpointSessionTurn({
    sessionId: session.id,
    messages: mergedMessages,
    outcome: "completed",
    userId: session.userId,
    sessionTitle: session.title,
  });

  return mergedMessages;
}

async function interactiveLoop(
  session: Session,
  maxSteps: number,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  logger.info("Interactive mode. Type your prompt and press Enter. Commands: /exit, /quit.");

  try {
    while (true) {
      const answer = (await rl.question(`\n\x1b[1myou ▸ \x1b[0m`)).trim();
      if (!answer) {
        continue;
      }
      if (answer === "/exit" || answer === "/quit") {
        break;
      }
      try {
        await runTurn(session, answer, maxSteps);
      } catch (error) {
        logger.error(
          error instanceof Error ? error.stack ?? error.message : String(error),
        );
      }
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.list) {
    await printSessions();
    return;
  }

  requireGatewayKey();

  if (args.testResume) {
    logger.banner(["baby-lovable agent · resume test"]);
    const result = await runResumeStreamTest();
    await printResumeTestResult(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  requireRemoteWorkspaceConfig();
  const session = await resolveSession(args);

  logger.banner([
    `baby-lovable agent · CLI`,
    `session   : ${session.id}`,
    `model     : ${process.env.AI_MODEL ?? "deepseek/deepseek-v4-flash"}`,
    `workspace : daytona:workspace`,
  ]);

  if (args.prompt) {
    await runTurn(session, args.prompt, args.maxSteps);
    logger.info(`Session saved. Resume with: npm run agent -- -s ${session.id}`);
    // One-shot mode: the preview bootstrap spawned a long-lived `pnpm dev`
    // child that keeps the event loop alive. Stop it so the process exits.
    await shutdownPreview(session);
    return;
  }

  await interactiveLoop(session, args.maxSteps);
  logger.info(`Session saved. Resume with: npm run agent -- -s ${session.id}`);
  await shutdownPreview(session);
}

/**
 * Tear down preview resources so the CLI can exit cleanly.
 *
 * Keep the remote sandbox + dev server alive so the preview URL remains
 * reachable after one-shot runs.
 */
async function shutdownPreview(session: Session): Promise<void> {
  try {
    const { getDaytonaAppServerStatus } = await import(
      "@/lib/sandbox/daytona/app-server"
    );
    const status = await getDaytonaAppServerStatus(session.id);
    if (status.status === "ready" && status.url) {
      logger.info(`Daytona sandbox kept — preview: ${status.url}`);
    } else {
      logger.info("Daytona sandbox kept (preview may still be starting)");
    }
  } catch {
    logger.info("Daytona sandbox kept");
  }
}

main()
  .then(() => {
    // Force exit in case any best-effort background handle (killed dev server,
    // pending timers) is still keeping the event loop alive.
    process.exit(0);
  })
  .catch((error) => {
    logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
