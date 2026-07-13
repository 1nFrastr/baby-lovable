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

  return name;
}
