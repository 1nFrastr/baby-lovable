import { createInterface } from "node:readline/promises";
import path from "node:path";

import { config as loadEnv } from "dotenv";

// Load environment before importing anything that reads process.env at module
// scope (e.g. the AI Gateway credentials). `.env.local` wins over `.env`.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { generateId, type UIMessage } from "ai";

import {
  appendMessages,
  createSession,
  deriveSessionTitle,
  getSession,
  listSessions,
  updateSession,
} from "@/lib/session/store";
import { getWorkspaceRoot } from "@/lib/sandbox/paths";
import type { Session } from "@/lib/session/types";
import type { SandboxMode } from "@/lib/sandbox/types";

import { logger } from "./logger";
import { runAgentTurn } from "./run-agent";

interface CliArgs {
  prompt?: string;
  sessionId?: string;
  sandboxMode: SandboxMode;
  maxSteps: number;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    sandboxMode: "local",
    maxSteps: 30,
    list: false,
    help: false,
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
        args.sandboxMode = argv[++i] === "daytona" ? "daytona" : "local";
        break;
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
      `      --sandbox <mode>   Sandbox mode: local (default) | daytona\n` +
      `      --max-steps <n>    Max agent steps per turn (default: 30)\n` +
      `  -l, --list             List existing sessions and exit\n` +
      `  -h, --help             Show this help\n\n` +
      `Examples:\n` +
      `  npm run agent -- -p "创建一个待办事项应用"\n` +
      `  npm run agent -- --session sess_abc123 -p "给标题加上渐变色"\n` +
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
      `  ${s.id}  ·  ${s.sandboxMode.padEnd(7)}  ·  ${s.updatedAt.slice(0, 19).replace("T", " ")}  ·  ${s.title}\n`,
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

  const session = await createSession({ sandboxMode: args.sandboxMode });
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

  const messages = [...session.messages, userMessage];

  const { assistantMessage } = await runAgentTurn({
    sessionId: session.id,
    sandboxMode: session.sandboxMode,
    messages,
    maxSteps,
  });

  const mergedMessages = assistantMessage
    ? [...messages, assistantMessage]
    : messages;

  await appendMessages(session.id, mergedMessages);

  if (session.title === "New Project") {
    const title = deriveSessionTitle(mergedMessages);
    if (title) {
      await updateSession(session.id, { title });
      session.title = title;
    }
  }

  session.messages = mergedMessages;
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
      const answer = (await rl.question(`\n\x1b[1m你 ▸ \x1b[0m`)).trim();
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

  const session = await resolveSession(args);
  const workspace = path.relative(process.cwd(), getWorkspaceRoot(session.id));

  logger.banner([
    `baby-lovable agent · CLI`,
    `session   : ${session.id}`,
    `sandbox   : ${session.sandboxMode}`,
    `model     : ${process.env.AI_MODEL ?? "minimax/minimax-m3"}`,
    `workspace : ${workspace}`,
  ]);

  if (args.prompt) {
    await runTurn(session, args.prompt, args.maxSteps);
    logger.info(`Session saved. Resume with: npm run agent -- -s ${session.id}`);
    // One-shot mode: the preview bootstrap spawned a long-lived `pnpm dev`
    // child that keeps the event loop alive. Stop it so the process exits.
    await shutdownPreview(session.id);
    return;
  }

  await interactiveLoop(session, args.maxSteps);
  logger.info(`Session saved. Resume with: npm run agent -- -s ${session.id}`);
  await shutdownPreview(session.id);
}

/**
 * Tear down the background dev server started during the turn so the CLI can
 * exit cleanly instead of hanging on the live child process.
 */
async function shutdownPreview(sessionId: string): Promise<void> {
  try {
    const { stopDevServer } = await import("@/lib/sandbox/dev-server");
    await stopDevServer(sessionId);
  } catch {
    // Best-effort: never block exit on teardown failures.
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
