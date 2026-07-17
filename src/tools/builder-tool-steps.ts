import type { SandboxMode } from "@/lib/sandbox/types";
import {
  buildAllowedShellCommand,
  validateRunCommand,
} from "@/lib/sandbox/command-policy";
import {
  filterListedFiles,
  isProtectedPath,
  workspacePathViolation,
} from "@/lib/sandbox/protected-paths";

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

export const toolContextSchema = {
  sessionId: "string",
  sandboxMode: "local | daytona",
} as const;

export type ToolContext = {
  sessionId: string;
  sandboxMode: SandboxMode;
};

async function getSandboxFromContext(context: ToolContext) {
  const { getProjectSandbox } = await import("@/lib/sandbox/factory");
  return getProjectSandbox(context.sessionId, context.sandboxMode);
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

  const sandbox = await getSandboxFromContext(context);
  await sandbox.fs.writeTextFile(input.path, input.content);

  return {
    ok: true,
    path: input.path,
    bytesWritten: new TextEncoder().encode(input.content).length,
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

  // Tolerate line-ending differences between the model's oldString (usually
  // "\n") and the on-disk file (which may contain "\r\n").
  const normalize = (value: string) => value.replace(/\r\n/g, "\n");
  const usesCrlf = original.includes("\r\n");
  const content = normalize(original);
  const oldString = normalize(input.oldString);
  const newString = normalize(input.newString);

  const countMatches = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  const matches = countMatches(content, oldString);

  if (matches === 0) {
    // Help the caller recover instead of blindly retrying: detect whether the
    // mismatch is only leading/trailing whitespace or indentation.
    const collapse = (value: string) =>
      value.replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
    const whitespaceInsensitiveMatch =
      collapse(content).includes(collapse(oldString));

    return {
      ok: false,
      path: input.path,
      error: whitespaceInsensitiveMatch
        ? "oldString was not found exactly. A near-match exists that differs only in whitespace/indentation — re-read the file and copy the exact characters (including leading spaces)."
        : "oldString was not found in the file. Re-read the file to copy the exact text, or use writeFile to replace the whole file.",
    };
  }

  if (matches > 1 && !input.replaceAll) {
    return {
      ok: false,
      path: input.path,
      matches,
      error:
        "oldString matched multiple locations. Add surrounding context to make it unique, or set replaceAll to true.",
    };
  }

  const updatedContent = input.replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  // Preserve the file's original line-ending style.
  const output = usesCrlf ? updatedContent.replace(/\n/g, "\r\n") : updatedContent;

  await sandbox.fs.writeTextFile(input.path, output);

  return {
    ok: true,
    path: input.path,
    replacements: input.replaceAll ? matches : 1,
    bytesWritten: new TextEncoder().encode(output).length,
  };
}

export async function listFilesStep(
  input: { path?: string },
  { context }: { context: ToolContext },
) {
  "use step";

  const targetPath = input.path ?? ".";
  const blocked = pathGuard("list", targetPath);
  if (blocked) {
    return { ...blocked, path: targetPath };
  }

  const sandbox = await getSandboxFromContext(context);
  const files = filterListedFiles(
    await sandbox.fs.listFiles(input.path ?? "."),
  );

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

  const targetPath = input.path ?? ".";
  const blocked = pathGuard("search", targetPath, {
    searchPattern: input.pattern,
  });
  if (blocked) {
    return { ...blocked, path: targetPath, pattern: input.pattern };
  }

  const sandbox = await getSandboxFromContext(context);
  const files = (
    await sandbox.fs.searchFiles(input.path ?? ".", input.pattern)
  ).filter((filePath) => !isProtectedPath(filePath));

  return {
    path: input.path ?? ".",
    pattern: input.pattern,
    files,
  };
}

async function restartPreviewAfterInstall(context: ToolContext): Promise<void> {
  const { restartAppServer } = await import("@/lib/sandbox/preview");
  void restartAppServer(context.sessionId).catch(() => {
    // Preview restart failures are surfaced through checkPreview.
  });
}

async function executeAllowedPnpmCommand(
  context: ToolContext,
  allowed: ReturnType<typeof validateRunCommand> & { ok: true },
  cwd?: string,
  timeout?: number,
) {
  const sandbox = await getSandboxFromContext(context);
  const result = await sandbox.process.executeCommand(
    allowed.shell,
    cwd,
    undefined,
    timeout,
  );

  if (result.exitCode === 0 && allowed.allowed.kind === "pkg-install") {
    await restartPreviewAfterInstall(context);
  }

  return {
    command: allowed.shell,
    cwd: cwd ?? ".",
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 20_000),
    stderr: result.stderr.slice(0, 20_000),
  };
}

export async function installPackageStep(
  input: {
    packages: string[];
    dev?: boolean;
    remove?: boolean;
  },
  { context }: { context: ToolContext },
) {
  "use step";

  const allowed = input.remove
    ? buildAllowedShellCommand(
        { kind: "pkg-remove", packages: input.packages },
        context.sandboxMode,
      )
    : buildAllowedShellCommand(
        {
          kind: "pkg-add",
          packages: input.packages,
          dev: input.dev ?? false,
        },
        context.sandboxMode,
      );

  const validation = validateRunCommand(allowed, context.sandboxMode);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
    };
  }

  const result = await executeAllowedPnpmCommand(context, validation);
  return {
    ok: result.exitCode === 0,
    ...result,
  };
}

export async function installDependenciesStep(
  _input: Record<string, never>,
  { context }: { context: ToolContext },
) {
  "use step";

  const pm = (await import("@/lib/sandbox/package-manager")).resolvePackageManager(
    context.sandboxMode,
  );
  const validation = validateRunCommand(pm.install, context.sandboxMode);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
    };
  }

  const result = await executeAllowedPnpmCommand(context, validation);
  return {
    ok: result.exitCode === 0,
    ...result,
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

  const validation = validateRunCommand(input.command, context.sandboxMode);
  if (!validation.ok) {
    return {
      ok: false,
      command: input.command,
      cwd: input.cwd ?? ".",
      exitCode: 1,
      stdout: "",
      stderr: validation.error,
    };
  }

  const result = await executeAllowedPnpmCommand(
    context,
    validation,
    input.cwd,
    input.timeout,
  );

  return {
    ok: result.exitCode === 0,
    ...result,
  };
}

export async function checkPreviewStep(
  input: { restart?: boolean },
  { context }: { context: ToolContext },
) {
  "use step";

  const {
    checkAppServer,
    isTempFailure,
    restartAppServer,
  } = await import("@/lib/sandbox/preview");

  if (input.restart) {
    await restartAppServer(context.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  } else {
    // Give HMR a moment to settle after the agent's last edit.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }

  let report = await checkAppServer(context.sessionId);
  let retried = false;

  for (
    let attempt = 0;
    attempt < 8 &&
    (report.status === "starting" || report.status === "installing");
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    report = await checkAppServer(context.sessionId);
    retried = true;
  }

  if (!input.restart && isTempFailure(report)) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    report = await checkAppServer(context.sessionId);
    retried = true;
  }

  return {
    status: report.status,
    url: report.url,
    httpStatus: report.httpStatus,
    buildError: report.buildError,
    retried,
    restarted: input.restart ?? false,
    ok:
      report.buildError === null &&
      report.status === "ready" &&
      (report.httpStatus === undefined || report.httpStatus < 500),
  };
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

  const sandbox = await getSandboxFromContext(context);
  await sandbox.fs.deleteFile(input.path, input.recursive ?? false);

  return {
    ok: true,
    path: input.path,
  };
}
