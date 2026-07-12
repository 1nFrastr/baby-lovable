import type { SandboxMode } from "@/lib/sandbox/types";
import {
  buildAllowedShellCommand,
  validateRunCommand,
} from "@/lib/sandbox/command-policy";

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

async function restartPreviewAfterInstall(sessionId: string): Promise<void> {
  const { restartDevServer } = await import("@/lib/sandbox/dev-server");
  void restartDevServer(sessionId).catch(() => {
    // Preview restart failures are surfaced through the preview API.
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

  if (result.exitCode === 0 && allowed.allowed.kind === "pnpm-install") {
    await restartPreviewAfterInstall(context.sessionId);
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
    ? buildAllowedShellCommand({ kind: "pnpm-remove", packages: input.packages })
    : buildAllowedShellCommand({
        kind: "pnpm-add",
        packages: input.packages,
        dev: input.dev ?? false,
      });

  const validation = validateRunCommand(allowed);
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

  const validation = validateRunCommand("pnpm install");
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

  const validation = validateRunCommand(input.command);
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
    httpStatus: report.httpStatus,
    buildError: report.buildError,
    ok:
      report.buildError === null &&
      report.status === "ready" &&
      (report.httpStatus === undefined || report.httpStatus < 500),
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
