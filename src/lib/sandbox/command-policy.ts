import type { SandboxMode } from "./types";
import { resolvePackageManager } from "./package-manager";

export type AllowedCommand =
  | { kind: "pkg-install" }
  | { kind: "pkg-add"; packages: string[]; dev: boolean }
  | { kind: "pkg-remove"; packages: string[] };

const INSTALL_RES: Record<"pnpm" | "npm", RegExp> = {
  pnpm: /^pnpm\s+install\s*$/,
  npm: /^npm\s+install\s*$/,
};

const ADD_RES: Record<"pnpm" | "npm", RegExp> = {
  pnpm: /^pnpm\s+add(?:\s+(-D|--save-dev))?\s+([\s\S]+)$/,
  npm: /^npm\s+install(?:\s+(-D|--save-dev))?\s+([\s\S]+)$/,
};

const REMOVE_RES: Record<"pnpm" | "npm", RegExp> = {
  pnpm: /^pnpm\s+remove\s+([\s\S]+)$/,
  npm: /^npm\s+uninstall\s+([\s\S]+)$/,
};

function splitPackageNames(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseWithManager(command: string, pm: "pnpm" | "npm"): AllowedCommand | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  if (INSTALL_RES[pm].test(trimmed)) {
    return { kind: "pkg-install" };
  }

  const addMatch = trimmed.match(ADD_RES[pm]);
  if (addMatch) {
    const packages = splitPackageNames(addMatch[2] ?? "");
    if (packages.length === 0) {
      return null;
    }
    return {
      kind: "pkg-add",
      packages,
      dev: Boolean(addMatch[1]),
    };
  }

  const removeMatch = trimmed.match(REMOVE_RES[pm]);
  if (removeMatch) {
    const packages = splitPackageNames(removeMatch[1] ?? "");
    if (packages.length === 0) {
      return null;
    }
    return { kind: "pkg-remove", packages };
  }

  return null;
}

/**
 * Parse a workspace shell command into a supported package-manager action.
 * Accepts both pnpm and npm spellings from the model.
 */
export function parseAllowedCommand(command: string): AllowedCommand | null {
  return (
    parseWithManager(command, "pnpm") ?? parseWithManager(command, "npm")
  );
}

export function buildAllowedShellCommand(
  command: AllowedCommand,
  sandboxMode: SandboxMode = "local",
): string {
  const pm = resolvePackageManager(sandboxMode);

  switch (command.kind) {
    case "pkg-install":
      return pm.install;
    case "pkg-add":
      return pm.add(command.packages, command.dev);
    case "pkg-remove":
      return pm.remove(command.packages);
  }
}

export const DISALLOWED_COMMAND_HINT =
  "Only package-manager commands are allowed. Use listFiles/searchFiles/readFile for inspection, checkPreview for preview health, and installPackage/installDependencies for dependencies. Never run curl, ls, find, grep, tail, or dev server commands.";

export function validateRunCommand(
  command: string,
  sandboxMode: SandboxMode = "local",
):
  | { ok: true; allowed: AllowedCommand; shell: string }
  | { ok: false; error: string } {
  const allowed = parseAllowedCommand(command);
  if (!allowed) {
    return { ok: false, error: DISALLOWED_COMMAND_HINT };
  }

  return {
    ok: true,
    allowed,
    shell: buildAllowedShellCommand(allowed, sandboxMode),
  };
}

/** @deprecated Use pkg-* kinds — kept for transitional call sites. */
export type LegacyAllowedCommand = AllowedCommand;
