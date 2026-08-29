#!/usr/bin/env tsx
/**
 * Switch `.env.local` Supabase settings between local Docker stack and linked remote.
 *
 * Usage:
 *   npm run supabase:use -- local
 *   npm run supabase:use -- remote
 *   npm run supabase:use -- status
 *   npm run supabase:use -- save-remote   # snapshot current .env.local → .env.supabase.remote
 *   npm run supabase:use -- save-local    # snapshot / refresh from `supabase status`
 *
 * Profiles (gitignored): `.env.supabase.local`, `.env.supabase.remote`
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ENV_LOCAL = path.join(ROOT, ".env.local");
const PROFILE = {
  local: path.join(ROOT, ".env.supabase.local"),
  remote: path.join(ROOT, ".env.supabase.remote"),
} as const;

const TARGET_KEY = "BABY_LOVABLE_SUPABASE_TARGET";
const LOCAL_DEV_USER_ID = "11111111-1111-1111-1111-111111111111";

const SUPABASE_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "BABY_LOVABLE_DEV_USER_ID",
] as const;

type Target = "local" | "remote";
type SupabaseEnv = Record<(typeof SUPABASE_KEYS)[number], string>;

function usage(exitCode = 1): never {
  console.error(`Usage:
  npm run supabase:use -- local|remote|status|save-local|save-remote

Profiles:
  .env.supabase.local   local Docker stack keys
  .env.supabase.remote  linked / hosted project keys

Switching rewrites only Supabase-related keys in .env.local (other secrets untouched).
Restart npm run dev / npm run agent after switching.`);
  process.exit(exitCode);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(filePath)) return map;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1));
    map.set(key, value);
  }
  return map;
}

function formatEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value) || value.length === 0) {
    return JSON.stringify(value);
  }
  return value;
}

function writeProfile(filePath: string, env: SupabaseEnv, header: string): void {
  const body = [
    `# ${header}`,
    `# Generated/updated by scripts/use-supabase-env.ts — do not commit.`,
    `${TARGET_KEY}=${filePath.endsWith(".local") ? "local" : "remote"}`,
    ...SUPABASE_KEYS.map((key) => `${key}=${formatEnvValue(env[key])}`),
    "",
  ].join("\n");
  writeFileSync(filePath, body, "utf8");
}

function readSupabaseEnv(map: Map<string, string>): Partial<SupabaseEnv> {
  const out: Partial<SupabaseEnv> = {};
  for (const key of SUPABASE_KEYS) {
    const value = map.get(key);
    if (value) out[key] = value;
  }
  return out;
}

function requireSupabaseEnv(
  partial: Partial<SupabaseEnv>,
  label: string,
): SupabaseEnv {
  const missing = SUPABASE_KEYS.filter((key) => !partial[key]);
  if (missing.length > 0) {
    throw new Error(`${label} missing: ${missing.join(", ")}`);
  }
  return partial as SupabaseEnv;
}

function detectTarget(url: string | undefined): Target | "unknown" {
  if (!url) return "unknown";
  if (
    url.includes("127.0.0.1") ||
    url.includes("localhost") ||
    url.startsWith("http://127.")
  ) {
    return "local";
  }
  if (url.includes("supabase.co") || url.startsWith("https://")) {
    return "remote";
  }
  return "unknown";
}

function redact(value: string | undefined): string {
  if (!value) return "(missing)";
  if (value.length <= 12) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 10)}…`;
}

function applyToEnvLocal(env: SupabaseEnv, target: Target): void {
  if (!existsSync(ENV_LOCAL)) {
    throw new Error(
      ".env.local not found. Copy .env.example → .env.local first.",
    );
  }

  const original = readFileSync(ENV_LOCAL, "utf8");
  const lines = original.split(/\r?\n/);
  const seen = new Set<string>();
  const updates: Record<string, string> = {
    [TARGET_KEY]: target,
    ...env,
  };

  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${formatEnvValue(updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      next.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  // Ensure trailing newline
  const text = next.join("\n").replace(/\n*$/, "\n");
  writeFileSync(ENV_LOCAL, text, "utf8");
}

function loadStatusEnv(): Record<string, string> {
  let raw: string;
  try {
    raw = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(
      `supabase status failed. Is Docker up and has \`supabase start\` finished?\n${err.stderr || err.message || error}`,
    );
  }

  const map: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map[line.slice(0, eq)] = stripQuotes(line.slice(eq + 1));
  }
  return map;
}

function buildLocalEnvFromStatus(): SupabaseEnv {
  const status = loadStatusEnv();
  const url = status.API_URL;
  // Prefer classic JWT keys — widely compatible; fall back to newer names.
  const publishable =
    status.ANON_KEY || status.PUBLISHABLE_KEY || status.NEXT_PUBLIC_ANON_KEY;
  const secret =
    status.SERVICE_ROLE_KEY || status.SECRET_KEY || status.SERVICE_ROLE;
  if (!url || !publishable || !secret) {
    throw new Error(
      "supabase status did not include API_URL / ANON_KEY / SERVICE_ROLE_KEY",
    );
  }

  const existing = parseEnvFile(PROFILE.local);
  const devUser =
    existing.get("BABY_LOVABLE_DEV_USER_ID") || LOCAL_DEV_USER_ID;

  return {
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
    SUPABASE_SECRET_KEY: secret,
    BABY_LOVABLE_DEV_USER_ID: devUser,
  };
}

function saveLocalProfile(): SupabaseEnv {
  const env = buildLocalEnvFromStatus();
  writeProfile(
    PROFILE.local,
    env,
    "Local Supabase (Docker) — from `supabase status`",
  );
  console.log(`Wrote ${path.basename(PROFILE.local)}`);
  return env;
}

function saveRemoteProfileFromEnvLocal(): SupabaseEnv {
  const map = parseEnvFile(ENV_LOCAL);
  const env = requireSupabaseEnv(
    readSupabaseEnv(map),
    ".env.local",
  );
  const target = detectTarget(env.NEXT_PUBLIC_SUPABASE_URL);
  if (target === "local") {
    throw new Error(
      ".env.local currently points at local Supabase. Switch/fill remote keys first, or edit .env.supabase.remote manually.",
    );
  }
  writeProfile(
    PROFILE.remote,
    env,
    "Remote / linked Supabase project — snapshotted from .env.local",
  );
  console.log(`Wrote ${path.basename(PROFILE.remote)}`);
  return env;
}

function ensureRemoteProfile(): SupabaseEnv {
  if (existsSync(PROFILE.remote)) {
    return requireSupabaseEnv(
      readSupabaseEnv(parseEnvFile(PROFILE.remote)),
      ".env.supabase.remote",
    );
  }
  console.log(
    "No .env.supabase.remote yet — snapshotting current .env.local as remote…",
  );
  return saveRemoteProfileFromEnvLocal();
}

function ensureLocalProfile(): SupabaseEnv {
  if (existsSync(PROFILE.local)) {
    // Refresh URL/keys from running stack when possible; keep saved DEV_USER_ID.
    try {
      return saveLocalProfile();
    } catch {
      return requireSupabaseEnv(
        readSupabaseEnv(parseEnvFile(PROFILE.local)),
        ".env.supabase.local",
      );
    }
  }
  return saveLocalProfile();
}

function printStatus(): void {
  const map = parseEnvFile(ENV_LOCAL);
  const url = map.get("NEXT_PUBLIC_SUPABASE_URL");
  const marked = map.get(TARGET_KEY) as Target | undefined;
  const detected = detectTarget(url);
  const active = marked || detected;

  console.log(`Active target: ${active}${marked ? "" : " (detected from URL)"}`);
  console.log(`NEXT_PUBLIC_SUPABASE_URL=${url ?? "(missing)"}`);
  console.log(
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${redact(map.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"))}`,
  );
  console.log(
    `SUPABASE_SECRET_KEY=${redact(map.get("SUPABASE_SECRET_KEY"))}`,
  );
  console.log(
    `BABY_LOVABLE_DEV_USER_ID=${map.get("BABY_LOVABLE_DEV_USER_ID") ?? "(missing)"}`,
  );
  console.log(
    `Profiles: local=${existsSync(PROFILE.local) ? "yes" : "no"}, remote=${existsSync(PROFILE.remote) ? "yes" : "no"}`,
  );
  if (active === "local") {
    console.log("Studio: http://127.0.0.1:54323");
  }
}

function switchTo(target: Target): void {
  // Preserve the other side before overwriting .env.local
  if (target === "local" && !existsSync(PROFILE.remote)) {
    const current = detectTarget(
      parseEnvFile(ENV_LOCAL).get("NEXT_PUBLIC_SUPABASE_URL"),
    );
    if (current === "remote") {
      saveRemoteProfileFromEnvLocal();
    }
  }

  const env =
    target === "local" ? ensureLocalProfile() : ensureRemoteProfile();
  applyToEnvLocal(env, target);
  console.log(`Switched .env.local → ${target}`);
  console.log(`NEXT_PUBLIC_SUPABASE_URL=${env.NEXT_PUBLIC_SUPABASE_URL}`);
  console.log(
    "Restart npm run dev / npm run agent for the change to take effect.",
  );
}

function main(): void {
  const cmd = process.argv[2];
  if (!cmd || cmd === "-h" || cmd === "--help") usage(cmd ? 0 : 1);

  try {
    switch (cmd) {
      case "local":
        switchTo("local");
        break;
      case "remote":
        switchTo("remote");
        break;
      case "status":
        printStatus();
        break;
      case "save-local":
        saveLocalProfile();
        break;
      case "save-remote":
        saveRemoteProfileFromEnvLocal();
        break;
      default:
        usage(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
