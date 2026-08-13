/**
 * Probe Daytona preview console log streaming (no browser).
 *
 * Modes:
 *   --standalone          Create ephemeral sandbox + echo loop; stream 8s
 *   -s <sessionId>        Attach existing session runtime and stream logs
 *   --sse <baseUrl> -s …  Hit GET /api/sessions/:id/preview/logs (needs host)
 *
 * Examples:
 *   npx tsx src/cli/probe-preview-logs.ts --standalone
 *   npx tsx src/cli/probe-preview-logs.ts -s sess_xxx --follow-ms 15000
 *   npx tsx src/cli/probe-preview-logs.ts -s sess_xxx --sse http://localhost:3000 --follow-ms 15000
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { Daytona } from "@daytona/sdk";

import { streamDevCommandLogs } from "@/lib/sandbox/daytona/dev-log-stream";
import { resolveDevCmdId } from "@/lib/sandbox/daytona/resolve-dev-cmd-id";
import { getExistingDaytonaSandbox } from "@/lib/sandbox/daytona/sandbox";
import { getRuntimeSnapshot } from "@/lib/sandbox/daytona/runtime-store";
import { getSession } from "@/lib/session/store";

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${tag.padEnd(10)} ${msg}`);
}

function parseArgs(argv: string[]) {
  let sessionId: string | undefined;
  let standalone = false;
  let sseBase: string | undefined;
  let followMs = 12_000;
  let keep = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-s" || a === "--session") {
      sessionId = argv[++i];
    } else if (a === "--standalone") {
      standalone = true;
    } else if (a === "--sse") {
      sseBase = argv[++i];
    } else if (a === "--follow-ms") {
      followMs = Number(argv[++i] ?? followMs);
    } else if (a === "--keep") {
      keep = true;
    } else if (a === "-h" || a === "--help") {
      console.log(`Usage:
  npx tsx src/cli/probe-preview-logs.ts --standalone [--follow-ms 12000] [--keep]
  npx tsx src/cli/probe-preview-logs.ts -s <sessionId> [--follow-ms 12000]
  npx tsx src/cli/probe-preview-logs.ts -s <sessionId> --sse http://localhost:3000
`);
      process.exit(0);
    }
  }

  return { sessionId, standalone, sseBase, followMs, keep };
}

async function probeStandalone(followMs: number, keep: boolean) {
  if (!process.env.DAYTONA_API_KEY && !process.env.DAYTONA_JWT_TOKEN) {
    throw new Error("DAYTONA_API_KEY not set");
  }

  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });

  log("CREATE", "ephemeral sandbox…");
  const sandbox = await daytona.create(
    { language: "typescript", labels: { test: "probe-preview-logs" } },
    { timeout: 180 },
  );
  await sandbox.waitUntilStarted(180);
  log("READY", `sandbox=${sandbox.id}`);

  const sessionName = `probe-logs-${Date.now()}`;
  await sandbox.process.createSession(sessionName);
  const cmd = await sandbox.process.executeSessionCommand(
    sessionName,
    {
      command:
        'for i in $(seq 1 30); do echo "probe-stdout $i"; echo "probe-stderr $i" >&2; sleep 0.4; done',
      runAsync: true,
    },
    30,
  );

  const cmdId =
    cmd.cmdId ??
    (await resolveDevCmdId(sandbox, sessionName, null)) ??
    null;
  log("CMD", `session=${sessionName} cmdId=${cmdId ?? "null"}`);
  if (!cmdId) {
    throw new Error("No cmdId from executeSessionCommand / session list");
  }

  const events: Array<{ t: number; type: string; detail?: string }> = [];
  const t0 = Date.now();
  const mark = (type: string, detail?: string) => {
    const row = { t: Date.now() - t0, type, detail };
    events.push(row);
    log(
      "EVENT",
      `+${row.t}ms ${type}${detail ? ` ${detail.slice(0, 120)}` : ""}`,
    );
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), followMs);

  try {
    await streamDevCommandLogs(
      sandbox,
      sessionName,
      cmdId,
      (event) => {
        if (event.type === "snapshot") {
          mark(
            "snapshot",
            `stdout=${(event.stdout ?? "").length}b stderr=${(event.stderr ?? "").length}b`,
          );
          if (event.stdout) {
            process.stdout.write(event.stdout);
          }
          if (event.stderr) {
            process.stderr.write(event.stderr);
          }
        } else if (event.type === "chunk") {
          mark("chunk", `${event.stream} ${event.text.length}b`);
          process.stdout.write(
            event.stream === "stderr" ? `[err] ${event.text}` : event.text,
          );
        } else {
          mark(event.type, "reason" in event ? event.reason : undefined);
        }
      },
      ac.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  const chunks = events.filter((e) => e.type === "chunk").length;
  const snaps = events.filter((e) => e.type === "snapshot").length;
  log("SUMMARY", `snapshot=${snaps} chunks=${chunks} events=${events.length}`);

  if (!keep) {
    log("DELETE", sandbox.id);
    await sandbox.delete();
  } else {
    log("KEEP", sandbox.id);
  }

  if (snaps < 1 || chunks < 1) {
    process.exitCode = 2;
    log("FAIL", "expected at least one snapshot and one chunk");
  } else {
    log("PASS", "standalone log stream OK");
  }
}

async function probeSession(sessionId: string, followMs: number) {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const snap = await getRuntimeSnapshot(sessionId, session.userId, {
    fresh: true,
  });
  log(
    "RUNTIME",
    `observed=${snap.observed} desired=${snap.desired} gen=${snap.generation} rev=${snap.revision}`,
  );
  log(
    "RUNTIME",
    `sandbox=${snap.sandboxId ?? "null"} session=${snap.devSessionName ?? "null"} cmdId=${snap.devCmdId ?? "null"}`,
  );

  if (!snap.devSessionName) {
    throw new Error("devSessionName missing — start preview first");
  }

  const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: true });
  if (!sandbox) {
    throw new Error("Could not attach Daytona sandbox");
  }

  const cmdId = await resolveDevCmdId(
    sandbox.sdkSandbox,
    snap.devSessionName,
    snap.devCmdId,
  );
  log("CMD", `resolved cmdId=${cmdId ?? "null"}`);
  if (!cmdId) {
    throw new Error("Could not resolve devCmdId from runtime or session list");
  }

  // List session commands for diagnostics
  try {
    const sess = await sandbox.sdkSandbox.process.getSession(snap.devSessionName);
    for (const c of sess.commands ?? []) {
      log(
        "SESSCMD",
        `id=${c.id} exit=${c.exitCode ?? "running"} cmd=${(c.command ?? "").slice(0, 80)}`,
      );
    }
  } catch (error) {
    log(
      "SESSCMD",
      `list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const events: Array<{ t: number; type: string }> = [];
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), followMs);

  try {
    await streamDevCommandLogs(
      sandbox.sdkSandbox,
      snap.devSessionName,
      cmdId,
      (event) => {
        events.push({ t: Date.now() - t0, type: event.type });
        if (event.type === "snapshot") {
          const text = `${event.stdout ?? ""}${event.stderr ?? ""}`;
          log("SNAPSHOT", `${text.length} bytes`);
          if (text) {
            process.stdout.write(text.slice(-4000));
            if (!text.endsWith("\n")) process.stdout.write("\n");
          }
        } else if (event.type === "chunk") {
          log("CHUNK", `${event.stream} ${event.text.length}b`);
          process.stdout.write(event.text);
        } else if (event.type === "stale" || event.type === "waiting") {
          log(event.type.toUpperCase(), event.reason);
        } else if (event.type === "error") {
          log("ERROR", event.message);
        }
      },
      ac.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  const timeline = events
    .map((e) => `+${e.t}ms:${e.type}`)
    .join(" → ");
  log("TIMELINE", timeline || "(none)");
  log(
    "SUMMARY",
    `snapshot=${events.filter((e) => e.type === "snapshot").length} chunks=${events.filter((e) => e.type === "chunk").length}`,
  );
}

async function probeSse(
  sessionId: string,
  baseUrl: string,
  followMs: number,
) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/preview/logs`;
  log("SSE", `GET ${url}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), followMs);
  const t0 = Date.now();
  const types: string[] = [];

  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
    log("SSE", `status=${res.status} content-type=${res.headers.get("content-type")}`);
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`SSE failed: ${res.status} ${body.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const dataLine = part
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) {
          if (part.startsWith(":")) {
            log("SSE", `+${Date.now() - t0}ms ping`);
          }
          continue;
        }
        try {
          const payload = JSON.parse(dataLine.slice(6)) as {
            type: string;
            text?: string;
            stdout?: string;
            stderr?: string;
            reason?: string;
            message?: string;
          };
          types.push(payload.type);
          log("SSE", `+${Date.now() - t0}ms ${payload.type}`);
          if (payload.type === "snapshot") {
            const text = `${payload.stdout ?? ""}${payload.stderr ?? ""}`;
            if (text) process.stdout.write(text.slice(-4000));
          } else if (payload.type === "chunk" && payload.text) {
            process.stdout.write(payload.text);
          } else if (payload.reason || payload.message) {
            log("SSE", payload.reason ?? payload.message ?? "");
          }
        } catch {
          log("SSE", `bad event: ${dataLine.slice(0, 120)}`);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  log("TIMELINE", types.join(" → ") || "(none)");
  if (!types.includes("meta") && !types.includes("snapshot") && !types.includes("waiting")) {
    process.exitCode = 2;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.standalone) {
    await probeStandalone(args.followMs, args.keep);
    return;
  }

  if (!args.sessionId) {
    throw new Error("Need --standalone or -s <sessionId>");
  }

  if (args.sseBase) {
    await probeSse(args.sessionId, args.sseBase, args.followMs);
    return;
  }

  await probeSession(args.sessionId, args.followMs);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
