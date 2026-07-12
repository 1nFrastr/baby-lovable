export type AllowedCommand =
  | { kind: "pnpm-install" }
  | { kind: "pnpm-add"; packages: string[]; dev: boolean }
  | { kind: "pnpm-remove"; packages: string[] };

const PNPM_INSTALL_RE = /^pnpm\s+install(?:\s|$)/;
const PNPM_ADD_RE = /^pnpm\s+add(?:\s+(-D|--save-dev))?\s+([\s\S]+)$/;
const PNPM_REMOVE_RE = /^pnpm\s+remove\s+([\s\S]+)$/;

function splitPackageNames(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Parse a workspace shell command into a supported package-manager action.
 * Returns null when the command is not on the allowlist.
 */
export function parseAllowedCommand(command: string): AllowedCommand | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  if (PNPM_INSTALL_RE.test(trimmed)) {
    return { kind: "pnpm-install" };
  }

  const addMatch = trimmed.match(PNPM_ADD_RE);
  if (addMatch) {
    const packages = splitPackageNames(addMatch[2] ?? "");
    if (packages.length === 0) {
      return null;
    }
    return {
      kind: "pnpm-add",
      packages,
      dev: Boolean(addMatch[1]),
    };
  }

  const removeMatch = trimmed.match(PNPM_REMOVE_RE);
  if (removeMatch) {
    const packages = splitPackageNames(removeMatch[1] ?? "");
    if (packages.length === 0) {
      return null;
    }
    return { kind: "pnpm-remove", packages };
  }

  return null;
}

export function buildAllowedShellCommand(command: AllowedCommand): string {
  switch (command.kind) {
    case "pnpm-install":
      return "pnpm install";
    case "pnpm-add":
      return command.dev
        ? `pnpm add -D ${command.packages.join(" ")}`
        : `pnpm add ${command.packages.join(" ")}`;
    case "pnpm-remove":
      return `pnpm remove ${command.packages.join(" ")}`;
  }
}

export const DISALLOWED_COMMAND_HINT =
  "Only package-manager commands are allowed. Use listFiles/searchFiles/readFile for inspection, checkPreview for preview health, and installPackage/installDependencies for dependencies. Never run curl, ls, find, grep, tail, or pnpm dev.";

export function validateRunCommand(command: string):
  | { ok: true; allowed: AllowedCommand; shell: string }
  | { ok: false; error: string } {
  const allowed = parseAllowedCommand(command);
  if (!allowed) {
    return { ok: false, error: DISALLOWED_COMMAND_HINT };
  }

  return {
    ok: true,
    allowed,
    shell: buildAllowedShellCommand(allowed),
  };
}
