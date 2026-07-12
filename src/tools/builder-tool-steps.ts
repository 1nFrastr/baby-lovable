import type { SandboxMode } from "@/lib/sandbox/types";

export const toolContextSchema = {
  sessionId: "string",
  sandboxMode: "local | daytona",
} as const;

export type ToolContext = {
  sessionId: string;
  sandboxMode: SandboxMode;
};

async function getSandboxFromContext(context: ToolContext) {
  const { createSandbox } = await import("@/lib/sandbox/factory");
  return createSandbox(context.sessionId, context.sandboxMode);
}

export async function readFileStep(
  input: { path: string },
  { context }: { context: ToolContext },
) {
  "use step";

  const sandbox = await getSandboxFromContext(context);
  const content = await sandbox.fs.readTextFile(input.path);

  return {
    path: input.path,
    content,
  };
}

export async function writeFileStep(
  input: { path: string; content: string },
  { context }: { context: ToolContext },
) {
  "use step";

  const sandbox = await getSandboxFromContext(context);
  await sandbox.fs.writeTextFile(input.path, input.content);

  return {
    ok: true,
    path: input.path,
    bytesWritten: new TextEncoder().encode(input.content).length,
  };
}

export async function listFilesStep(
  input: { path?: string },
  { context }: { context: ToolContext },
) {
  "use step";

  const sandbox = await getSandboxFromContext(context);
  const files = await sandbox.fs.listFiles(input.path ?? ".");

  return {
    path: input.path ?? ".",
    files,
  };
}

export async function searchFilesStep(
  input: { path?: string; pattern: string },
  { context }: { context: ToolContext },
) {
  "use step";

  const sandbox = await getSandboxFromContext(context);
  const files = await sandbox.fs.searchFiles(input.path ?? ".", input.pattern);

  return {
    path: input.path ?? ".",
    pattern: input.pattern,
    files,
  };
}

export async function runCommandStep(
  input: {
    command: string;
    cwd?: string;
    timeout?: number;
  },
  { context }: { context: ToolContext },
) {
  "use step";

  const sandbox = await getSandboxFromContext(context);
  const result = await sandbox.process.executeCommand(
    input.command,
    input.cwd,
    undefined,
    input.timeout,
  );

  if (
    result.exitCode === 0 &&
    /\bpnpm\s+install\b/.test(input.command)
  ) {
    const { restartDevServer } = await import("@/lib/sandbox/dev-server");
    void restartDevServer(context.sessionId).catch(() => {
      // Preview restart failures are surfaced through the preview API.
    });
  }

  return {
    command: input.command,
    cwd: input.cwd ?? ".",
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 20_000),
    stderr: result.stderr.slice(0, 20_000),
  };
}

export async function checkPreviewStep(
  _input: Record<string, never>,
  { context }: { context: ToolContext },
) {
  "use step";

  const { getPreviewReport } = await import("@/lib/sandbox/dev-server");
  // Give a just-triggered recompile a moment to settle before reporting.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const report = await getPreviewReport(context.sessionId);

  return {
    status: report.status,
    url: report.url,
    buildError: report.buildError,
    ok: report.buildError === null && report.status === "ready",
  };
}

export async function deleteFileStep(
  input: { path: string; recursive?: boolean },
  { context }: { context: ToolContext },
) {
  "use step";

  const sandbox = await getSandboxFromContext(context);
  await sandbox.fs.deleteFile(input.path, input.recursive ?? false);

  return {
    ok: true,
    path: input.path,
  };
}
