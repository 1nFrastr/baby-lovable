/**
 * Build and push the baby-lovable Vercel Sandbox image to VCR.
 *
 * Usage:
 *   npm run build:vercel-image
 *   npm run build:vercel-image -- --force
 *   npm run build:vercel-image -- --tag v1
 *
 * Then new Vercel sessions boot `VERCEL_SANDBOX_IMAGE` (default
 * `baby-lovable-nextjs-starter`) instead of `vercel/sandbox/universal`.
 */
import "@/lib/load-host-env";

import { spawn } from "node:child_process";
import { mkdtemp, cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  VERCEL_DEFAULT_IMAGE,
  isVercelSandboxConfigured,
} from "@/lib/sandbox/vercel/config";

interface BuildArgs {
  force: boolean;
  tag: string;
  repository: string;
}

function parseArgs(argv: string[]): BuildArgs {
  const args: BuildArgs = {
    force: false,
    tag: "latest",
    repository: VERCEL_DEFAULT_IMAGE,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force" || arg === "-f") {
      args.force = true;
      continue;
    }
    if ((arg === "--tag" || arg === "-t") && argv[i + 1]) {
      args.tag = argv[++i]!;
      continue;
    }
    if ((arg === "--name" || arg === "-n") && argv[i + 1]) {
      args.repository = argv[++i]!;
      continue;
    }
  }
  return args;
}

function run(
  command: string,
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdin ? ["pipe", "inherit", "inherit"] : "inherit",
      env: { ...process.env, ...options.env },
    });
    if (options.stdin) {
      child.stdin?.end(options.stdin);
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function vercelJson<T>(pathname: string): Promise<T> {
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId =
    process.env.VERCEL_TEAM_ID?.trim() || process.env.VERCEL_ORG_ID?.trim();
  if (!token || !teamId) {
    throw new Error("VERCEL_TOKEN and VERCEL_TEAM_ID are required to resolve VCR path");
  }
  const url = new URL(`https://api.vercel.com${pathname}`);
  if (!pathname.includes("teamId=")) {
    url.searchParams.set("teamId", teamId);
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vercel API ${pathname} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

async function resolveTeamSlug(teamId: string): Promise<string> {
  const fromEnv = process.env.VERCEL_TEAM_SLUG?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const team = await vercelJson<{ slug?: string }>(
      `/v2/teams/${encodeURIComponent(teamId)}`,
    );
    const slug = team.slug?.trim();
    if (slug) {
      return slug;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("403")) {
      throw error;
    }
  }
  throw new Error(
    "Could not read the Vercel team slug with VERCEL_TOKEN. Set VERCEL_TEAM_SLUG to the team URL slug.",
  );
}

async function resolveVcrImageRef(
  repository: string,
  tag: string,
): Promise<{ ref: string; createImage: string }> {
  const teamId =
    process.env.VERCEL_TEAM_ID?.trim() || process.env.VERCEL_ORG_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!teamId || !projectId) {
    throw new Error("VERCEL_TEAM_ID and VERCEL_PROJECT_ID are required");
  }

  const project = await vercelJson<{ name?: string }>(
    `/v9/projects/${encodeURIComponent(projectId)}`,
  );
  const projectSlug = project.name?.trim();
  const teamSlug = await resolveTeamSlug(teamId);
  if (!teamSlug || !projectSlug) {
    throw new Error("Could not resolve Vercel team slug / project name for VCR");
  }

  const ref = `vcr.vercel.com/${teamSlug}/${projectSlug}/${repository}:${tag}`;
  const createImage = tag === "latest" ? repository : `${repository}:${tag}`;
  return { ref, createImage };
}

async function stageBuildContext(repoRoot: string): Promise<string> {
  const ctx = await mkdtemp(path.join(os.tmpdir(), "bl-vercel-image-"));
  const starterSrc = path.join(repoRoot, "templates", "nextjs-starter");
  const dockerfileSrc = path.join(
    repoRoot,
    "src/lib/sandbox/vercel/image/Dockerfile",
  );
  const warmSrc = path.join(
    repoRoot,
    "src/lib/sandbox/daytona/scripts/warm-next-dev.sh",
  );
  const keenableSrc = path.join(
    repoRoot,
    "src/lib/sandbox/scripts/install-keenable.sh",
  );

  const babySrc = path.join(repoRoot, "src/lib/agent/skills/baby.sh");
  const skillsSrc = path.join(repoRoot, "skills");

  await mkdir(path.join(ctx, "starter"), { recursive: true });
  await cp(starterSrc, path.join(ctx, "starter"), { recursive: true });
  await cp(skillsSrc, path.join(ctx, "skills"), { recursive: true });
  await cp(babySrc, path.join(ctx, "baby"));
  await cp(dockerfileSrc, path.join(ctx, "Dockerfile"));
  await cp(warmSrc, path.join(ctx, "warm-next-dev.sh"));
  await cp(keenableSrc, path.join(ctx, "install-keenable.sh"));
  await writeFile(
    path.join(ctx, ".dockerignore"),
    ["starter/node_modules", "starter/.next", "starter/.git"].join("\n") + "\n",
  );
  return ctx;
}

/**
 * VCR's authenticated `GET /v2/` answers 404, so `docker login` rejects a valid
 * permanent token. Buildx still accepts the same basic auth from a config file.
 */
async function writeVcrDockerConfig(teamId: string, token: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bl-vcr-docker-"));
  const userPlugins = path.join(os.homedir(), ".docker", "cli-plugins");
  await symlink(userPlugins, path.join(dir, "cli-plugins")).catch(() => undefined);
  const auth = Buffer.from(`${teamId}:${token}`).toString("base64");
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify({ auths: { "vcr.vercel.com": { auth } } })}\n`,
    { mode: 0o600 },
  );
  return dir;
}

async function main(): Promise<void> {
  if (!isVercelSandboxConfigured()) {
    throw new Error(
      "Vercel Sandbox is not configured. Set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
    );
  }

  const { tag, repository } = parseArgs(process.argv.slice(2));

  const { ref, createImage } = await resolveVcrImageRef(repository, tag);
  const token = process.env.VERCEL_TOKEN!.trim();
  const teamId = (process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID)!.trim();

  console.log(`Using .env.local VERCEL_TOKEN for vcr.vercel.com (team ${teamId})…`);
  const dockerConfig = await writeVcrDockerConfig(teamId, token);

  const repoRoot = process.cwd();
  const ctx = await stageBuildContext(repoRoot);
  try {
    console.log(
      `Building linux/amd64 image ${ref} (starter + pnpm + node_modules + .next/dev warm)…`,
    );
    await run(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--provenance=false",
        "--output",
        `type=image,name=${ref},push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true`,
        ctx,
      ],
      { env: { DOCKER_CONFIG: dockerConfig } },
    );
  } finally {
    await rm(ctx, { recursive: true, force: true });
    await rm(dockerConfig, { recursive: true, force: true });
  }

  console.log(`\nImage pushed: ${ref}`);
  console.log(`Sandbox.create image: ${createImage}`);
  console.log(
    "VCR prepares a linux/amd64 snapshot after push; wait until the repository is Ready, then:",
  );
  console.log(`  VERCEL_SANDBOX_IMAGE=${createImage}`);
  console.log(
    "Cold start should skip runtime `pnpm install` and reuse Turbopack/dev cache.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
