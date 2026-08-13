export type PackageManager = "pnpm" | "npm";

export interface PackageManagerCommands {
  pm: PackageManager;
  install: string;
  add: (packages: string[], dev?: boolean) => string;
  remove: (packages: string[]) => string;
  dev: (port: number) => string;
  lockfile: "pnpm-lock.yaml" | "package-lock.json";
}

function pnpmCommands(): PackageManagerCommands {
  return {
    pm: "pnpm",
    install: "pnpm install",
    add: (packages, dev = false) =>
      dev ? `pnpm add -D ${packages.join(" ")}` : `pnpm add ${packages.join(" ")}`,
    remove: (packages) => `pnpm remove ${packages.join(" ")}`,
    dev: (port) => `pnpm dev --port ${port}`,
    lockfile: "pnpm-lock.yaml",
  };
}

/** Resolve install/dev shell commands for the Daytona workspace. */
export function resolvePackageManager(): PackageManagerCommands {
  return pnpmCommands();
}

export function packageManagerPromptLines(
  devPort = 3000,
): string[] {
  const pm = resolvePackageManager();
  return [
    `Use the installPackage and installDependencies tools for package management (platform runs ${pm.pm} internally).`,
    `After editing dependencies, call installPackage or installDependencies — never run arbitrary shell commands.`,
    `The platform automatically installs dependencies and runs the dev server (${pm.dev(devPort)}) in the background. NEVER run dev server commands yourself — the platform owns the dev server lifecycle.`,
    `Writable lockfile: ${pm.lockfile}.`,
  ];
}
