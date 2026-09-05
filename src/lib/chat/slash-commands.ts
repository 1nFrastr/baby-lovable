export type SlashSurface = "web" | "cli";

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: readonly string[];
  surfaces: readonly SlashSurface[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "summarize",
    description: "Compress conversation context into a summary",
    surfaces: ["web", "cli"],
  },
  {
    name: "exit",
    description: "Leave the interactive CLI",
    aliases: ["quit"],
    surfaces: ["cli"],
  },
] as const;

export type ComposerSubmit =
  | { kind: "empty" }
  | { kind: "message"; text: string }
  | { kind: "command"; command: SlashCommand; args: string }
  | { kind: "unknown-command"; name: string }
  | { kind: "slash-draft"; query: string };

const COMMAND_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function listSlashCommands(surface: SlashSurface): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => command.surfaces.includes(surface));
}

export function getSlashCommand(name: string): SlashCommand | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  return SLASH_COMMANDS.find(
    (command) =>
      command.name === needle ||
      command.aliases?.some((alias) => alias === needle),
  );
}

/** True when the composer value is a `/` draft (menu should open). */
export function isSlashMenuDraft(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const body = trimmed.slice(1);
  return body === "" || COMMAND_NAME.test(body);
}

export function slashMenuQuery(text: string): string | null {
  if (!isSlashMenuDraft(text)) {
    return null;
  }
  return text.trim().slice(1).toLowerCase();
}

export function matchSlashCommands(
  query: string,
  surface: SlashSurface,
): SlashCommand[] {
  const available = listSlashCommands(surface);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return available;
  }

  const prefix: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const command of available) {
    const names = [command.name, ...(command.aliases ?? [])];
    if (names.some((name) => name.startsWith(needle))) {
      prefix.push(command);
      continue;
    }
    if (command.description.toLowerCase().includes(needle)) {
      rest.push(command);
    }
  }
  return [...prefix, ...rest];
}

function parseSlashLine(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) {
    return null;
  }
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * Interpret a composer submit.
 *
 * A unique prefix (`/sum` → summarize) resolves to that command. Pass
 * `highlightedName` when the slash menu handled Enter on a specific row.
 */
export function resolveComposerSubmit(
  text: string,
  options?: {
    surface?: SlashSurface;
    highlightedName?: string;
  },
): ComposerSubmit {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: "empty" };
  }
  if (!trimmed.startsWith("/")) {
    return { kind: "message", text: trimmed };
  }

  const surface = options?.surface ?? "web";
  const query = slashMenuQuery(trimmed);
  if (query != null) {
    if (options?.highlightedName) {
      const highlighted = getSlashCommand(options.highlightedName);
      if (highlighted && highlighted.surfaces.includes(surface)) {
        return { kind: "command", command: highlighted, args: "" };
      }
    }

    const matches = matchSlashCommands(query, surface);
    if (query && matches.length === 1 && matches[0]) {
      return { kind: "command", command: matches[0], args: "" };
    }
    if (matches.length === 0 && query) {
      return { kind: "unknown-command", name: query };
    }
    return { kind: "slash-draft", query };
  }

  const parsed = parseSlashLine(trimmed);
  if (!parsed) {
    return { kind: "slash-draft", query: "" };
  }

  const command = getSlashCommand(parsed.name);
  if (!command || !command.surfaces.includes(surface)) {
    return { kind: "unknown-command", name: parsed.name };
  }
  return { kind: "command", command, args: parsed.args };
}
