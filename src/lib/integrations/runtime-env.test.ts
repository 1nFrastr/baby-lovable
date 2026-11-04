import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSandbox, SandboxFileSystem } from "@/lib/sandbox/types";
import { startDevSession } from "@/lib/sandbox/daytona/app-server-boot";
import { startVercelDevSession } from "@/lib/sandbox/vercel/app-server-boot";

import { syncIntegrationEnvToWorkspace } from "./runtime-env";
import { IntegrationSecretsDecryptionError } from "./secrets";
import { IntegrationStorageNotReadyError, readSessionIntegrations } from "./store";
import { formatEnvFile, type SessionIntegrationsRecord } from "./types";

vi.mock("./store", async (original) => ({
  ...await original<typeof import("./store")>(),
  readSessionIntegrations: vi.fn(),
}));
vi.mock("@/lib/sandbox/vercel/provider", () => ({
  asVercelProject: (project: ProjectSandbox) => project,
  VercelProjectSandbox: class {},
}));

const readIntegrations = vi.mocked(readSessionIntegrations);
const record: SessionIntegrationsRecord = {
  sessionId: "sess_test", userId: "user_test",
  supabaseStatus: "disconnected", supabaseProjectRef: null,
  supabaseProjectName: null, supabaseProjectUrl: null,
  supabaseLinkMethod: null, supabaseSecrets: null, supabaseError: null,
  stripeStatus: "linked", stripeMode: "test", stripePublishableKeyHint: "pk_test",
  stripeSecrets: { publishableKey: "pk_test_fake", secretKey: "sk_test_fake$literal" },
  stripeError: null, deployStatus: "idle", deployProvider: null,
  deployId: null, deployUrl: null, deployError: null, deployUpdatedAt: null,
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("integration runtime environment", () => {
  let root: string;
  let project: ProjectSandbox;
  let commands: string[];

  beforeEach(async () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "a".repeat(64));
    readIntegrations.mockReset().mockResolvedValue(record);
    root = await mkdtemp(path.join(os.tmpdir(), "integration-env-test-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    commands = [];
    const absolute = (file: string) => path.resolve(root, file);
    const fs: Pick<SandboxFileSystem,
      "listFiles" | "readTextFile" | "writeTextFile" | "deleteFile" | "createFolder"> = {
      listFiles: async (file) => (await readdir(absolute(file), { withFileTypes: true }))
        .map((entry) => ({ name: entry.name, path: path.join(file, entry.name), isDir: entry.isDirectory(), size: 0 })),
      readTextFile: (file) => readFile(absolute(file), "utf8"),
      writeTextFile: (file, content) => writeFile(absolute(file), content),
      deleteFile: (file) => rm(absolute(file)),
      createFolder: async (file) => { await mkdir(absolute(file), { recursive: true }); },
    };
    project = {
      rootDir: root,
      fs: fs as SandboxFileSystem,
      git: { isRepoInitialized: async () => true },
      process: {
        executeCommand: async (command) => {
          commands.push(command);
          try {
            const stdout = execFileSync("sh", ["-c", command], { cwd: root, encoding: "utf8", stdio: "pipe" });
            return { exitCode: 0, stdout, stderr: "" };
          } catch (error) {
            const result = error as { status: number; stdout: string; stderr: string };
            return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
          }
        },
      },
    } as ProjectSandbox;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("preserves user env, rotates/removes managed keys, and keeps them out of Git", async () => {
    const user = "# User config\nAPP_NAME='My app'\n";
    await writeFile(path.join(root, ".env.local"), user);
    await writeFile(path.join(root, ".gitignore"), "# User patterns\n*.tmp\n");
    const synced = await syncIntegrationEnvToWorkspace("sess_test", project);
    expect(synced).toEqual({ wrote: true, keys: ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY"] });
    expect(await readFile(path.join(root, ".env.local"), "utf8"))
      .toContain(user + "# BEGIN baby-lovable integrations\n");
    expect(await readFile(path.join(root, ".git/info/exclude"), "utf8"))
      .toContain("/.env.local\n");
    expect(await readFile(path.join(root, ".gitignore"), "utf8"))
      .toBe("# User patterns\n*.tmp\n");
  });

  it("blocks secrets when a user gitignore negation overrides info/exclude", async () => {
    await writeFile(path.join(root, ".gitignore"), "!.env.local\n");
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .rejects.toThrow("Preview startup was blocked");
    await expect(readFile(path.join(root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds Git protection even if the environment is already up to date", async () => {
    await syncIntegrationEnvToWorkspace("sess_test", project);
    await writeFile(path.join(root, ".git/info/exclude"), "");
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .resolves.toMatchObject({ wrote: false });
    execFileSync("git", ["add", "-A"], { cwd: root });
    expect(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })).not.toContain(".env.local");
    expect(commands.join("\n")).not.toContain(record.stripeSecrets!.secretKey);
  });

  it("removes stale credentials on unlink and on a missing record, preserving user entries", async () => {
    const user = "CUSTOM=keep\n";
    await writeFile(path.join(root, ".env.local"), user + formatEnvFile({ STRIPE_SECRET_KEY: "old", STRIPE_WEBHOOK_SECRET: "stale" }));
    readIntegrations.mockResolvedValue({ ...record, stripeStatus: "disconnected", stripeSecrets: null });
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .resolves.toEqual({ wrote: true, keys: [] });
    expect(await readFile(path.join(root, ".env.local"), "utf8")).toBe(user);
    await writeFile(path.join(root, ".env.local"), formatEnvFile({ STRIPE_SECRET_KEY: "old" }));
    readIntegrations.mockResolvedValue(null);
    await syncIntegrationEnvToWorkspace("sess_test", project);
    await expect(readFile(path.join(root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports ordinary previews without a key, a record, or the migration", async () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "");
    readIntegrations.mockResolvedValue(null);
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .resolves.toEqual({ wrote: false, keys: [] });
    readIntegrations.mockRejectedValue(new IntegrationStorageNotReadyError());
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .resolves.toEqual({ wrote: false, keys: [] });
    expect(commands).toEqual([]);
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "a".repeat(64));
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .rejects.toThrow(IntegrationStorageNotReadyError);
  });

  it("does not swallow DB outages or decryption failures even with no host key", async () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "");
    readIntegrations.mockRejectedValue(new Error("Database unavailable"));
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .rejects.toThrow("Preview startup was blocked");
    readIntegrations.mockRejectedValue(new IntegrationSecretsDecryptionError());
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .rejects.toThrow(IntegrationSecretsDecryptionError);
  });

  it("refuses writing secrets into a tracked env file", async () => {
    await writeFile(path.join(root, ".env.local"), "USER_VALUE=keep\n");
    execFileSync("git", ["add", "-f", ".env.local"], { cwd: root });
    await expect(syncIntegrationEnvToWorkspace("sess_test", project))
      .rejects.toThrow("Preview startup was blocked");
    expect(await readFile(path.join(root, ".env.local"), "utf8")).toBe("USER_VALUE=keep\n");
  });

  it("sanitizes filesystem errors containing credential buffers", async () => {
    vi.spyOn(project.fs, "writeTextFile").mockRejectedValue(new Error("upload sk_test_fake$literal"));
    const failure = await syncIntegrationEnvToWorkspace("sess_test", project).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("sk_test_fake");
    expect((failure as Error).cause).toBeUndefined();
  });

  it("starts neither provider's dev process after integration sync fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    readIntegrations.mockRejectedValue(new IntegrationSecretsDecryptionError());
    const executeSessionCommand = vi.fn();
    const runCommand = vi.fn();
    const augmented = Object.assign(project, {
      sdkSandbox: { id: "sandbox_test", process: { executeSessionCommand }, runCommand },
    });
    await expect(startDevSession(augmented as unknown as Parameters<typeof startDevSession>[0], "sess_test"))
      .rejects.toThrow(IntegrationSecretsDecryptionError);
    await expect(startVercelDevSession(augmented, "sess_test"))
      .rejects.toThrow(IntegrationSecretsDecryptionError);
    expect(executeSessionCommand).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
