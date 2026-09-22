import { isCompactedFilePayload } from "@/lib/agent/context-compact";
import { applyEdit } from "@/lib/agent/edit-apply";
import { buildAllowedShellCommand, parseAllowedCommand } from "@/lib/sandbox/command-policy";
import { clipHeadTail } from "@/lib/sandbox/exec-output";
import {
  capExecTimeout,
  evaluateExecPolicy,
} from "@/lib/sandbox/exec-policy";
import { workspacePathViolation } from "@/lib/sandbox/protected-paths";

function pathGuard(
  operation: Parameters<typeof workspacePathViolation>[0],
  path: string,
  options?: { searchPattern?: string },
) {
  const error = workspacePathViolation(operation, path, options);
  if (!error) {
    return null;
  }

  return { ok: false as const, error };
}

const COMPACTED_WRITE_ERROR =
  "Refusing to write a compacted history stub. Call readFile for the current file, then write the real contents.";

export type ToolContext = {
  sessionId: string;
};

async function getSandboxFromContext(context: ToolContext) {
  const { getProjectSandbox } = await import("@/lib/sandbox/factory");
  return getProjectSandbox(context.sessionId);
}

/** Wait for prior Freestyle checkpoint / provision before writes. */
async function awaitMutationGate(context: ToolContext) {
  const { awaitPreviousCheckpoint } = await import(
    "@/lib/git/await-checkpoint"
  );
  await awaitPreviousCheckpoint(context.sessionId);
}

export async function readFileStep(
  input: { path: string },
  { context }: { context: ToolContext },
) {
  "use step";

  const blocked = pathGuard("read", input.path);
  if (blocked) {
    return { ...blocked, path: input.path };
  }

  const sandbox = await getSandboxFromContext(context);
  const normalized = input.path.replace(/\\/g, "/");
  if (normalized === ".baby" || normalized.startsWith(".baby/")) {
    const { ensureBabyRuntime } = await import(
      "@/lib/agent/skills/ensure-runtime"
    );
    await ensureBabyRuntime(sandbox);
  }

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

  const blocked = pathGuard("write", input.path);
  if (blocked) {
    return { ...blocked, path: input.path };
  }

  if (isCompactedFilePayload(input.content)) {
    return {
      ok: false as const,
      path: input.path,
      error: COMPACTED_WRITE_ERROR,
    };
  }

  try {
    await awaitMutationGate(context);
  } catch (error) {
    return {
      ok: false as const,
      path: input.path,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const sandbox = await getSandboxFromContext(context);
  await sandbox.fs.writeTextFile(input.path, input.content);

  const { peekCompileErrorIfPreviewReady } = await import(
    "@/lib/sandbox/preview"
  );
  const compileError = await peekCompileErrorIfPreviewReady(context.sessionId);

  return {
    ok: true,
    path: input.path,
    bytesWritten: new TextEncoder().encode(input.content).length,
    ...(compileError ? { compileError } : {}),
  };
}

export async function editFileStep(
  input: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  },
  { context }: { context: ToolContext },
) {
  "use step";

  const blocked = pathGuard("edit", input.path);
  if (blocked) {
    return { ...blocked, path: input.path };
  }

  if (
    isCompactedFilePayload(input.oldString) ||
    isCompactedFilePayload(input.newString)
  ) {
    return {
      ok: false as const,
      path: input.path,
      error: COMPACTED_WRITE_ERROR,
    };
  }

  try {
    await awaitMutationGate(context);
  } catch (error) {
    return {
      ok: false as const,
      path: input.path,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const sandbox = await getSandboxFromContext(context);
  const original = await sandbox.fs.readTextFile(input.path);

  if (input.oldString.length === 0) {
    return {
      ok: false,
      path: input.path,
      error: "oldString must not be empty",
    };
  }

  if (input.oldString === input.newString) {
    return {
      ok: false,
      path: input.path,
      error: "oldString and newString are identical; nothing to change",
    };
  }

  const applied = applyEdit(
    original,
    input.oldString,
    input.newString,
    input.replaceAll === true,
  );

  if (!applied.ok) {
    return {
      ok: false,
      path: input.path,
      ...(applied.matches !== undefined ? { matches: applied.matches } : {}),
      error: applied.error,
    };
  }

  const output = applied.content;

  await sandbox.fs.writeTextFile(input.path, output);

  const { peekCompileErrorIfPreviewReady } = await import(
    "@/lib/sandbox/preview"
  );
  const compileError = await peekCompileErrorIfPreviewReady(context.sessionId);

  return {
    ok: true,
    path: input.path,
    replacements: applied.replacements,
    bytesWritten: new TextEncoder().encode(output).length,
    ...(compileError ? { compileError } : {}),
  };
}

async function restartPreviewAfterInstall(context: ToolContext): Promise<void> {
  const { restartAppServer } = await import("@/lib/sandbox/preview");
  void restartAppServer(context.sessionId).catch(() => {
    // Preview restart failures are surfaced through checkPreview.
  });
}

export async function execStep(
  input: {
    command: string;
    cwd?: string;
    timeout?: number;
  },
  { context }: { context: ToolContext },
) {
  "use step";

  const command = input.command.trim();
  const cwd = input.cwd ?? ".";
  const policy = evaluateExecPolicy(command);
  if (!policy.ok) {
    return {
      ok: false,
      command,
      cwd,
      exitCode: 1,
      stdout: "",
      stderr: policy.error,
      truncated: false,
    };
  }

  const mutating = policy.kind === "pkg" || policy.kind === "skill-script";
  if (mutating) {
    try {
      await awaitMutationGate(context);
    } catch (error) {
      return {
        ok: false,
        command,
        cwd,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }
  }

  const sandbox = await getSandboxFromContext(context);
  const { ensureBabyRuntime, refreshPreviewLogMirror } = await import(
    "@/lib/agent/skills/ensure-runtime"
  );
  await ensureBabyRuntime(sandbox);
  await refreshPreviewLogMirror(sandbox);

  const timeout = capExecTimeout(input.timeout ?? policy.timeoutDefault);
  let shell = command;
  const wholePkg = parseAllowedCommand(command);
  if (policy.kind === "pkg" && wholePkg) {
    shell = buildAllowedShellCommand(wholePkg);
  }
  const wrapped = `export PATH="$(pwd)/.baby/bin:$PATH"; ${shell}`;

  const result = await sandbox.process.executeCommand(
    wrapped,
    cwd,
    undefined,
    timeout,
  );

  if (result.exitCode === 0 && mutating) {
    await restartPreviewAfterInstall(context);
  }

  const stdout = clipHeadTail(result.stdout);
  const stderr = clipHeadTail(result.stderr);

  return {
    ok: result.exitCode === 0,
    command,
    cwd,
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

export async function checkPreviewStep(
  input: { restart?: boolean },
  { context }: { context: ToolContext },
) {
  "use step";

  const { runCheckPreviewProbe } = await import("@/lib/sandbox/preview");
  return runCheckPreviewProbe(context.sessionId, { restart: input.restart });
}

export async function testPreviewStep(
  input: {
    actions: Array<{
      action:
        | "fill"
        | "click"
        | "press"
        | "hover"
        | "assertVisible"
        | "assertHidden"
        | "wait"
        | "screenshot";
      selector?: string;
      text?: string;
      value?: string;
      key?: string;
      ms?: number;
      name?: string;
      timeoutMs?: number;
      continueOnError?: boolean;
    }>;
    holdMs?: number;
  },
  { context }: { context: ToolContext },
) {
  "use step";

  const { parseAppTestActions, runAppTest } = await import("@/lib/browser-run");

  let actions;
  try {
    actions = parseAppTestActions(input.actions);
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      consoleErrorCount: 0,
      pageErrorCount: 0,
      stepCount: 0,
      screenshotCount: 0,
      usedScriptedActions: false,
      failedSteps: [] as Array<{ name: string; detail?: string }>,
      durationMs: 0,
      liveViewUrl: undefined as string | undefined,
      liveViewLogged: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const report = await runAppTest({
    sessionId: context.sessionId,
    // Hold after Live View is ready so the Web UI poller (durable store) can
    // pick up liveViewUrl before automation finishes — critical on Vercel.
    holdMs: input.holdMs ?? 5_000,
    actions,
  });

  const failedSteps = report.steps
    .filter((s) => !s.ok)
    .slice(0, 8)
    .map((s) => ({ name: s.name, detail: s.detail }));

  return {
    ok: report.ok,
    summary: report.summary,
    consoleErrorCount: report.consoleErrors.length,
    pageErrorCount: report.pageErrors.length,
    stepCount: report.steps.length,
    screenshotCount: report.screenshots.length,
    usedScriptedActions: report.usedScriptedActions ?? false,
    failedSteps,
    artifactDir: report.artifactDir,
    durationMs: report.durationMs,
    liveViewUrl: report.liveViewUrl,
    liveViewLogged: Boolean(report.liveViewUrl),
    error: report.error,
  };
}

export async function deleteFileStep(
  input: { path: string; recursive?: boolean },
  { context }: { context: ToolContext },
) {
  "use step";

  const blocked = pathGuard("delete", input.path);
  if (blocked) {
    return { ...blocked, path: input.path };
  }

  try {
    await awaitMutationGate(context);
  } catch (error) {
    return {
      ok: false as const,
      path: input.path,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const sandbox = await getSandboxFromContext(context);
  await sandbox.fs.deleteFile(input.path, input.recursive ?? false);

  return {
    ok: true,
    path: input.path,
  };
}
