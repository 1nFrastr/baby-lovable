import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import {
  stopTrackedDevCommand,
  vercelDevLaunch,
  vercelDevPortFreeProgram,
  vercelDevSupervisorProgram,
} from "./dev-process";

describe("vercel dev process control", () => {
  it("launches pnpm under the supervisor instead of pkill", () => {
    const launch = vercelDevLaunch(3000);
    expect(launch.cmd).toBe("node");
    expect(launch.cwd).toBe("/vercel/sandbox");
    expect(launch.args[0]).toBe("-e");
    expect(launch.args[2]).toBe("--");
    expect(launch.args.slice(3).join(" ")).toBe("pnpm dev --port 3000");
    expect(launch.args.join("\n")).not.toContain("pkill");
    expect(vercelDevSupervisorProgram()).toContain("detached: true");
    expect(vercelDevSupervisorProgram()).toContain("process.kill(-child.pid");
  });

  it("SIGTERM to the supervisor kills the child process group", async () => {
    const child = spawn(
      process.execPath,
      ["-e", vercelDevSupervisorProgram(), "--", "sleep", "60"],
      { stdio: "ignore" },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => {
        child.once("exit", (exitCode) => resolve(exitCode));
      });
      expect(code).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("stops a running command with SIGTERM and waits for exit", async () => {
    const signals: string[] = [];
    const command = {
      exitCode: null as number | null,
      async kill(signal: "SIGTERM" | "SIGKILL") {
        signals.push(signal);
        this.exitCode = 0;
      },
      async wait() {
        if (this.exitCode == null) {
          throw new Error("still running");
        }
      },
    };
    await stopTrackedDevCommand(
      { getCommand: async () => command },
      "cmd_1",
    );
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("does not kill a command that has already exited", async () => {
    let killed = false;
    await stopTrackedDevCommand(
      {
        getCommand: async () => ({
          exitCode: 0,
          async kill() {
            killed = true;
          },
          async wait() {},
        }),
      },
      "cmd_done",
    );
    expect(killed).toBe(false);
    await stopTrackedDevCommand(
      {
        getCommand: async () => {
          throw new Error("missing");
        },
      },
      "cmd_missing",
    );
    await stopTrackedDevCommand({ getCommand: async () => {
      throw new Error("unused");
    } }, null);
  });

  it("reports a listening port as busy and a closed port as free", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "0.0.0.0", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const busy = await runPortProbe(port, 300);
      expect(busy).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    const free = await runPortProbe(port, 1000);
    expect(free).toBe(0);
  });
});

function runPortProbe(port: number, timeoutMs: number): Promise<number | null> {
  const child = spawn(
    process.execPath,
    ["-e", vercelDevPortFreeProgram(), "--", String(port), String(timeoutMs)],
    { stdio: "ignore" },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}
