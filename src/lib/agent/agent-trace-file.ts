import fs from "node:fs/promises";
import path from "node:path";

import { getSessionRoot } from "@/lib/sandbox/paths";

export async function appendAgentLogLines(
  sessionId: string,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  const logPath = path.join(getSessionRoot(sessionId), "agent.log");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const payload = lines
    .map((line) => (line.endsWith("\n") ? line : `${line}\n`))
    .join("");
  await fs.appendFile(logPath, payload, "utf8");
}
