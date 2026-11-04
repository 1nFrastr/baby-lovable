import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import { IntegrationError } from "./errors";

export interface VercelTeam {
  id: string;
  slug: string;
  name: string;
}

export interface VercelProject {
  id: string;
  name: string;
  /** Hostname from the project's production aliases; empty before one is assigned. */
  productionDomain: string;
  createdAt?: number;
}

export interface VercelDeployment {
  id: string;
  state: string;
  url: string | null;
  error: string | null;
}

export interface VercelUploadedFile {
  file: string;
  sha: string;
  size: number;
  mode?: number;
}

export interface VercelDeploymentInput {
  projectId: string;
  name: string;
  files: VercelUploadedFile[];
  env: Record<string, string>;
  jobId: string;
  sourceSha: string;
}

/** Safe to expose to callers: never retains a provider body, token, or cause. */
export class VercelApiError extends IntegrationError {
  constructor(message: string, status = 502, readonly uncertain = false) {
    super(message, status, "vercel_api_error");
    this.name = "VercelApiError";
  }
}

const API_ORIGIN = "https://api.vercel.com";
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_CHARACTERS = 32_000;

type JsonObject = Record<string, unknown>;

function invalidResponse(mutation = false): never {
  throw new VercelApiError("Vercel returned an invalid response.", 502, mutation);
}

function object(value: unknown, mutation = false): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidResponse(mutation);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, mutation = false): string {
  if (typeof value !== "string" || !value) return invalidResponse(mutation);
  return value;
}

function segment(value: string): string {
  if (!value || value === "." || value === "..") {
    throw new VercelApiError("A Vercel resource identifier is required.", 400);
  }
  return encodeURIComponent(value);
}

function scoped(teamId: string, query: Record<string, string> = {}): Record<string, string> {
  if (!teamId.trim()) throw new VercelApiError("A Vercel team is required.", 400);
  return { ...query, teamId };
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* No provider errors escape. */ }
}

/** All URLs are constructed internally; redirects cannot forward the bearer token. */
async function request(
  token: string,
  path: string,
  query: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> {
  if (!token.trim() || /[\r\n]/.test(token)) {
    throw new VercelApiError("A valid Vercel access token is required.", 400);
  }
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const mutation = init.method === "POST";
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    response = await fetch(url.toString(), {
      ...init,
      headers,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new VercelApiError("Vercel could not be reached. Check the operation status before trying again.", 504, mutation);
  }
  if (!response.ok) {
    await discard(response);
    throw new VercelApiError(
      `Vercel could not complete the request (${response.status}).`,
      response.status,
      mutation && (response.status >= 500 || response.status === 408),
    );
  }
  return response;
}

async function readText(response: Response, maxBytes: number, mutation = false): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new VercelApiError("Vercel response exceeded the size limit.", 502, mutation);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof VercelApiError) throw error;
    throw new VercelApiError("Vercel response could not be read.", 502, mutation);
  } finally {
    reader.releaseLock();
  }
}

async function json(
  token: string,
  path: string,
  query: Record<string, string>,
  body?: JsonObject,
): Promise<unknown> {
  const mutation = body !== undefined;
  const response = await request(token, path, query, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await readText(response, MAX_JSON_BYTES, mutation);
  try { return JSON.parse(text) as unknown; } catch { return invalidResponse(mutation); }
}

/** Timestamp cursors are followed only up to a fixed bound; never return a partial scan. */
async function* pages(
  token: string,
  path: string,
  query: Record<string, string>,
  collection: string,
): AsyncGenerator<unknown[]> {
  const cursors = new Set<number>();
  let until: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = object(await json(token, path, {
      ...query, limit: String(PAGE_SIZE), ...(until === undefined ? {} : { until: String(until) }),
    }));
    const items = data[collection];
    if (!Array.isArray(items)) invalidResponse();
    yield items;
    const next = data.pagination == null ? null : object(data.pagination).next;
    if (next == null) return;
    if (typeof next !== "number" || !Number.isFinite(next) || next < 0 || cursors.has(next)) {
      throw new VercelApiError("Vercel returned an invalid pagination cursor.");
    }
    cursors.add(next);
    until = next;
  }
  throw new VercelApiError("Vercel pagination limit exceeded. Narrow the request before trying again.");
}

export async function listVercelTeams(token: string): Promise<VercelTeam[]> {
  const teams = new Map<string, VercelTeam>();
  for await (const items of pages(token, "/v2/teams", {}, "teams")) {
    for (const item of items) {
      const team = object(item);
      const id = requiredString(team.id);
      teams.set(id, { id, slug: requiredString(team.slug), name: requiredString(team.name) });
    }
  }
  return [...teams.values()];
}

function domain(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253) return null;
  // API aliases are hostnames, never deployment URLs or arbitrary URLs.
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value)
    ? value.toLowerCase() : null;
}

function productionAlias(project: JsonObject): string | null {
  const targets = project.targets == null ? null : object(project.targets);
  const production = targets?.production == null ? null : object(targets.production);
  if (production && Array.isArray(production.alias)) {
    for (const alias of production.alias) {
      const hostname = domain(alias);
      if (hostname && hostname !== domain(production.url)) return hostname;
    }
  }
  // The actual project.alias schema is an array of domain objects, not strings.
  if (Array.isArray(project.alias)) {
    for (const item of project.alias) {
      const alias = object(item);
      if ((alias.environment === "production" || alias.target === "PRODUCTION") && !alias.gitBranch && !alias.redirect) {
        const hostname = domain(alias.domain);
        if (hostname) return hostname;
      }
    }
  }
  return null;
}

async function projectResult(token: string, teamId: string, value: unknown, mutation = false): Promise<VercelProject> {
  const project = object(value, mutation);
  const result = {
    id: requiredString(project.id, mutation),
    name: requiredString(project.name, mutation),
    productionDomain: productionAlias(project) ?? "",
    ...(typeof project.createdAt === "number" ? { createdAt: project.createdAt } : {}),
  };
  if (result.productionDomain) return result;
  // This endpoint also works before the first deployment, when targets is empty.
  for await (const items of pages(token, `/v9/projects/${segment(result.id)}/domains`, scoped(teamId, {
    production: "true", target: "production", redirects: "false", verified: "true",
  }), "domains")) {
    for (const item of items) {
      const entry = object(item);
      if (entry.verified === false || entry.gitBranch || entry.customEnvironmentId || entry.redirect) continue;
      const hostname = domain(entry.name);
      if (hostname) return { ...result, productionDomain: hostname };
    }
  }
  // Do not invent <name>.vercel.app: names can collide and Vercel assigns a suffix.
  return result;
}

export async function createVercelProject(token: string, teamId: string, name: string): Promise<VercelProject> {
  const value = await json(token, "/v11/projects", scoped(teamId), { name, framework: "nextjs" });
  try {
    return await projectResult(token, teamId, value, true);
  } catch (error) {
    // The project was created even if its subsequent domain lookup failed.
    if (error instanceof VercelApiError) throw new VercelApiError(error.message, error.status, true);
    throw new VercelApiError("Vercel project details could not be read.", 502, true);
  }
}

export async function getVercelProject(token: string, teamId: string, projectId: string): Promise<VercelProject> {
  return projectResult(token, teamId, await json(token, `/v9/projects/${segment(projectId)}`, scoped(teamId)));
}

/** Host-only decrypted values, for conflict checks; never write these to session state or logs. */
export async function getVercelProjectEnv(
  token: string,
  teamId: string,
  projectId: string,
): Promise<{ key: string; value?: string; target?: string[] | string }[]> {
  const data = object(await json(token, `/v10/projects/${segment(projectId)}/env`, scoped(teamId, { decrypt: "true" })));
  if (!Array.isArray(data.envs)) invalidResponse();
  // This endpoint normally returns the entire env set and has no documented
  // cursor input. Never silently miss conflicts if a partial response is sent.
  if (data.pagination && object(data.pagination).next != null) {
    throw new VercelApiError("Vercel returned an incomplete environment variable list.");
  }
  return data.envs.map((item: unknown) => {
    const env = object(item);
    const target = env.target;
    if (target !== undefined && typeof target !== "string" &&
      !(Array.isArray(target) && target.every((value) => typeof value === "string"))) invalidResponse();
    return {
      key: requiredString(env.key),
      ...(typeof env.value === "string" && env.decrypted !== false ? { value: env.value } : {}),
      ...(target === undefined ? {} : { target: target as string | string[] }),
    };
  });
}

export async function uploadVercelFiles(
  token: string,
  teamId: string,
  files: { path: string; content: Buffer; mode?: number }[],
): Promise<VercelUploadedFile[]> {
  const query = scoped(teamId);
  const unique = new Map<string, Buffer>();
  const result = files.map((file) => {
    const sha = createHash("sha1").update(file.content).digest("hex");
    unique.set(sha, file.content);
    return { file: file.path, sha, size: file.content.byteLength, ...(file.mode === undefined ? {} : { mode: file.mode }) };
  });
  // Bound the whole upload pass, not just each file, so a workflow step can
  // persist its result before its lease and server execution budget expire.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  timer.unref?.();
  const entries = [...unique.entries()];
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (cursor < entries.length) {
        const [sha, content] = entries[cursor++];
        const response = await request(token, "/v2/files", query, {
          method: "POST", signal: controller.signal,
          headers: {
            "Content-Type": "application/octet-stream", "Content-Length": String(content.byteLength),
            "x-vercel-digest": sha, "x-vercel-size": String(content.byteLength),
          },
          body: new Uint8Array(content),
        });
        await discard(response);
      }
    }));
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function deploymentResult(value: unknown, mutation = false): VercelDeployment {
  const data = object(value, mutation);
  const state = requiredString(data.readyState ?? data.state, mutation);
  return {
    id: requiredString(data.id ?? data.uid, mutation),
    state,
    url: domain(data.url),
    // Provider errorMessage can echo source or env secrets; detailed text belongs in redacted logs.
    error: state === "ERROR" || state === "BLOCKED" || data.errorCode || data.errorMessage
      ? "Vercel deployment failed. Check the build logs for details." : null,
  };
}

export async function createVercelDeployment(
  token: string,
  teamId: string,
  input: VercelDeploymentInput,
): Promise<VercelDeployment> {
  if (!input.projectId.trim() || !input.name.trim() || !input.jobId.trim() || !input.sourceSha.trim()) {
    throw new VercelApiError("Vercel deployment project, name, job, and source are required.", 400);
  }
  // env + build.env are used by Vercel's official client, though omitted from
  // the public OpenAPI request schema. They override only this deployment.
  // https://github.com/vercel/vercel/blob/main/packages/client/src/types.ts
  return deploymentResult(await json(token, "/v13/deployments", scoped(teamId), {
    name: input.name,
    project: input.projectId,
    target: "production",
    projectSettings: { framework: "nextjs" },
    files: input.files.map(({ file, sha, size, mode }) => ({ file, sha, size, ...(mode === undefined ? {} : { mode }) })),
    env: input.env,
    build: { env: input.env },
    meta: { jobId: input.jobId, sourceSha: input.sourceSha },
  }), true);
}

export async function getVercelDeployment(token: string, teamId: string, id: string): Promise<VercelDeployment> {
  return deploymentResult(await json(token, `/v13/deployments/${segment(id)}`, scoped(teamId)));
}

/** A null result means no match in a complete scan, not proof that an in-flight create failed. */
export async function findVercelDeployment(
  token: string,
  teamId: string,
  projectId: string,
  jobId: string,
): Promise<VercelDeployment | null> {
  if (!projectId.trim() || !jobId.trim()) {
    throw new VercelApiError("Vercel deployment project and job are required.", 400);
  }
  // Metadata filtering is not in the public list schema. Filter locally instead
  // of assuming an unsupported meta-jobId query parameter is honored.
  for await (const items of pages(token, "/v7/deployments", scoped(teamId, { projectId }), "deployments")) {
    for (const item of items) {
      const entry = object(item);
      if (entry.projectId !== undefined && entry.projectId !== projectId) continue;
      if (entry.meta && object(entry.meta).jobId === jobId) return deploymentResult(entry);
    }
  }
  return null;
}

function sanitizeLogs(text: string, token: string): string {
  const clean = stripVTControlCharacters(text)
    // Preserve line breaks and tabs; remove other controls, including bidi overrides.
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => /[\n\t]/.test(character) ? character : "")
    .split(token).join("[REDACTED]");
  return clean
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;}]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/gi, "$1 [REDACTED]")
    .slice(-MAX_LOG_CHARACTERS);
}

export async function getVercelBuildLogs(token: string, teamId: string, id: string): Promise<string> {
  const response = await request(token, `/v3/deployments/${segment(id)}/events`, scoped(teamId, {
    follow: "0", builds: "1", direction: "backward", limit: "200",
  }));
  const text = await readText(response, MAX_LOG_BYTES);
  let events: unknown;
  try { events = JSON.parse(text); } catch { return invalidResponse(); }
  if (events === null) return "";
  if (!Array.isArray(events)) return invalidResponse();
  // The documented JSON response supports both flat text and payload.text.
  const lines = events.map((event: unknown) => {
    const row = object(event);
    const payload = row.payload == null ? null : object(row.payload);
    const message = row.text ?? payload?.text;
    return typeof message === "string" ? message : "";
  });
  return sanitizeLogs(lines.filter(Boolean).reverse().join("\n"), token);
}
