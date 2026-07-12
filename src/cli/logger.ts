/**
 * Lightweight console logger for the CLI agent runner.
 *
 * Provides colorized, timestamped output so the agent's execution flow
 * (model steps, tool calls, results, token usage, errors) is easy to follow
 * and debug from a terminal. No external dependencies.
 */

const useColor =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

type Color = keyof typeof ansi;

function paint(text: string, ...colors: Color[]): string {
  if (!useColor) {
    return text;
  }
  return `${colors.map((c) => ansi[c]).join("")}${text}${ansi.reset}`;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function prefix(label: string, color: Color): string {
  return `${paint(timestamp(), "gray")} ${paint(label.padEnd(9), color, "bold")}`;
}

export { truncate } from "@/lib/agent/truncate";

export const logger = {
  banner(lines: string[]): void {
    const width = Math.max(...lines.map((l) => l.length)) + 2;
    const bar = "─".repeat(width);
    process.stdout.write(paint(`┌${bar}┐\n`, "cyan"));
    for (const line of lines) {
      process.stdout.write(
        paint("│ ", "cyan") + line.padEnd(width - 1) + paint("│\n", "cyan"),
      );
    }
    process.stdout.write(paint(`└${bar}┘\n`, "cyan"));
  },

  info(message: string): void {
    process.stdout.write(`${prefix("INFO", "blue")}  ${message}\n`);
  },

  system(message: string): void {
    process.stdout.write(`${prefix("SYSTEM", "magenta")}  ${message}\n`);
  },

  step(message: string): void {
    process.stdout.write(`${prefix("STEP", "cyan")}  ${message}\n`);
  },

  tool(message: string): void {
    process.stdout.write(`${prefix("TOOL", "yellow")}  ${message}\n`);
  },

  toolOk(message: string): void {
    process.stdout.write(`${prefix("TOOL✓", "green")}  ${message}\n`);
  },

  toolErr(message: string): void {
    process.stdout.write(`${prefix("TOOL✗", "red")}  ${message}\n`);
  },

  success(message: string): void {
    process.stdout.write(`${prefix("DONE", "green")}  ${message}\n`);
  },

  warn(message: string): void {
    process.stdout.write(`${prefix("WARN", "yellow")}  ${message}\n`);
  },

  error(message: string): void {
    process.stderr.write(`${prefix("ERROR", "red")}  ${paint(message, "red")}\n`);
  },

  /** Marks the start of the assistant's streamed answer. */
  assistantStart(): void {
    process.stdout.write(`\n${paint("assistant ▸ ", "green", "bold")}`);
  },

  /** Raw text token streamed from the model. */
  assistantDelta(text: string): void {
    process.stdout.write(text);
  },

  /** Dimmed reasoning token streamed from the model. */
  reasoningDelta(text: string): void {
    process.stdout.write(paint(text, "gray"));
  },

  /** Ends the streamed assistant block. */
  assistantEnd(): void {
    process.stdout.write("\n\n");
  },

  raw(text: string): void {
    process.stdout.write(text);
  },
};
