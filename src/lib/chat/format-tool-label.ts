import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";

const FILE_PATH_TOOLS = new Set([
  "readFile",
  "writeFile",
  "editFile",
  "deleteFile",
]);

/** Present / past activity verbs for Cursor-style inline labels. */
const ACTIVITY_VERBS: Record<string, [running: string, done: string]> = {
  readFile: ["Reading", "Read"],
  writeFile: ["Writing", "Wrote"],
  editFile: ["Editing", "Edited"],
  deleteFile: ["Deleting", "Deleted"],
  listFiles: ["Listing files", "Listed files"],
  searchFiles: ["Searching", "Searched"],
  installPackage: ["Installing", "Installed"],
  installDependencies: ["Installing dependencies", "Installed dependencies"],
  checkPreview: ["Checking preview", "Checked preview"],
  testPreview: ["Testing preview", "Tested preview"],
  runCommand: ["Running", "Ran"],
};

function readStringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object" || !(field in input)) {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isToolRunning(state: ToolUIPart["state"] | DynamicToolUIPart["state"]) {
  return (
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested"
  );
}

function activityVerb(name: string, running: boolean): string {
  const pair = ACTIVITY_VERBS[name];
  if (pair) {
    return running ? pair[0] : pair[1];
  }
  return running ? name : name;
}

/**
 * Human-readable tool activity label for chat UI (Cursor-style).
 * Shows file paths as soon as partial JSON includes them (input-streaming).
 * Omits large fields such as writeFile `content`.
 */
export function formatToolPartLabel(
  part: ToolUIPart | DynamicToolUIPart,
): string {
  const name = getToolName(part);
  const input = "input" in part ? part.input : undefined;
  const running = isToolRunning(part.state);
  const verb = activityVerb(name, running);

  if (FILE_PATH_TOOLS.has(name)) {
    const path = readStringField(input, "path");
    if (path) {
      return `${verb} ${path}`;
    }
    return verb;
  }

  if (name === "searchFiles") {
    const pattern = readStringField(input, "pattern");
    if (pattern) {
      return `${verb} ${pattern}`;
    }
    return verb;
  }

  if (name === "installPackage") {
    const packageName = readStringField(input, "name");
    if (packageName) {
      return `${verb} ${packageName}`;
    }
    return verb;
  }

  if (name === "testPreview") {
    const actions =
      input && typeof input === "object" && "actions" in input
        ? (input as { actions?: unknown }).actions
        : undefined;
    if (Array.isArray(actions) && actions.length > 0) {
      return `${verb} · ${actions.length} step${actions.length === 1 ? "" : "s"}`;
    }
    return verb;
  }

  if (ACTIVITY_VERBS[name]) {
    return verb;
  }

  return name;
}

/** Inspection tools — label only; raw content floods the chat. */
const HIDE_OUTPUT_TOOLS = new Set(["readFile", "listFiles", "searchFiles"]);

/** Compact result line for tool outputs (avoids dumping large JSON). */
export function formatToolPartOutput(
  part: ToolUIPart | DynamicToolUIPart,
): string | null {
  if (part.state !== "output-available" || part.output == null) {
    return null;
  }

  const name = getToolName(part);
  if (HIDE_OUTPUT_TOOLS.has(name)) {
    return null;
  }

  const output = part.output;

  if (name === "testPreview" && output && typeof output === "object") {
    const rec = output as {
      ok?: boolean;
      summary?: string;
      error?: string;
    };
    const mark = rec.ok ? "✓" : "✗";
    const summary = (rec.summary ?? rec.error ?? "").trim();
    if (summary) {
      return `${mark} ${summary.slice(0, 160)}`;
    }
    return mark;
  }

  if (name === "checkPreview" && output && typeof output === "object") {
    const rec = output as { ok?: boolean; httpStatus?: number };
    if (rec.ok) {
      return rec.httpStatus != null ? `ok · ${rec.httpStatus}` : "ok";
    }
    return rec.httpStatus != null ? `failed · ${rec.httpStatus}` : "failed";
  }

  return JSON.stringify(output).slice(0, 120);
}

const OMIT_INPUT_FIELDS = new Set(["content", "old_string", "new_string"]);

/**
 * Compact tool input for the chat Tool panel.
 * Drops writeFile/editFile payloads that would flood the UI.
 */
export function compactToolInput(
  part: ToolUIPart | DynamicToolUIPart,
): unknown {
  const input = "input" in part ? part.input : undefined;
  if (!input || typeof input !== "object") {
    return input ?? {};
  }

  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (OMIT_INPUT_FIELDS.has(key) && typeof value === "string") {
      compact[key] = `[${value.length} chars]`;
      continue;
    }
    if (typeof value === "string" && value.length > 200) {
      compact[key] = `${value.slice(0, 120)}…`;
      continue;
    }
    compact[key] = value;
  }
  return compact;
}
