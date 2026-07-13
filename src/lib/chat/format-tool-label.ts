import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";

const FILE_PATH_TOOLS = new Set([
  "readFile",
  "writeFile",
  "editFile",
  "deleteFile",
]);

function readStringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object" || !(field in input)) {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Human-readable tool label for chat UI.
 * Shows file paths as soon as partial JSON includes them (input-streaming).
 * Omits large fields such as writeFile `content`.
 */
export function formatToolPartLabel(
  part: ToolUIPart | DynamicToolUIPart,
): string {
  const name = getToolName(part);
  const input = "input" in part ? part.input : undefined;

  if (FILE_PATH_TOOLS.has(name)) {
    const path = readStringField(input, "path");
    if (path) {
      return `${name} · ${path}`;
    }
  }

  if (name === "searchFiles") {
    const pattern = readStringField(input, "pattern");
    if (pattern) {
      return `${name} · ${pattern}`;
    }
  }

  if (name === "installPackage") {
    const packageName = readStringField(input, "name");
    if (packageName) {
      return `${name} · ${packageName}`;
    }
  }

  if (name === "testPreview") {
    const actions =
      input && typeof input === "object" && "actions" in input
        ? (input as { actions?: unknown }).actions
        : undefined;
    if (Array.isArray(actions) && actions.length > 0) {
      return `${name} · ${actions.length} step${actions.length === 1 ? "" : "s"}`;
    }
    return name;
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

  return JSON.stringify(output).slice(0, 120);
}
