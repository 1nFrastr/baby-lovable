import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import { getSessionMeta } from "@/lib/session/store";

import { configuredVercelConnector, getAppConnectToken } from "./connect";
import { readRuntimeIntegrations } from "./credentials";
import { IntegrationError } from "./errors";
import { exportPublishSource, resolvePublishSource } from "./publish-source";
import { buildGeneratedAppEnv, type SessionIntegrationsProjection } from "./types";
import {
  createVercelDeployment, createVercelProject, findVercelDeployment, getVercelBuildLogs,
  getVercelDeployment, getVercelProject, getVercelProjectEnv, listVercelTeams,
  uploadVercelFiles, VercelApiError, type VercelProject,
} from "./vercel-api";
import {
  bindPublishProject, claimPublishJob, deleteVercelConnection, enqueuePublishJob, finishPublishJob,
  patchPublishJob, readPublishJob, readLatestPublishJob, readLegacyPublication, readPublishTarget, readVercelConnection,
  selectPublishTeam, type PublishJob,
} from "./vercel-publish-store";

const DEADLINE_MS = 45 * 60_000;
export const PUBLISH_ERRORS: Record<string, string> = {
  vercel_not_connected: "Connect your Vercel account before publishing.",
  vercel_team_required: "Select and save a Vercel Team before publishing.",
  vercel_permission: "Vercel denied access. Reconnect with Team read, Projects and Deployments write, and Production Environment Variables read permissions.",
  vercel_project_permission: "Vercel denied project creation. Check your Team role and enable Projects write permission for the OAuth application.",
  vercel_project_conflict: "A project with this app's reserved name already exists. Review it in Vercel before publishing.",
  vercel_env_conflict: "A production environment variable in Vercel conflicts with this app's connected services. Review the project variables before publishing.",
  vercel_authorization_required: "Your Vercel authorization expired or changed. Reconnect Vercel to continue.",
  vercel_network: "Vercel could not be reached. Check your connection and try again.",
  vercel_build_failed: "Vercel could not build this app. Review the build output, fix the app, and publish again.",
  vercel_publish_failed: "Publishing could not complete. Check the saved source and connected services, then try again.",
  vercel_publish_timeout: "The deployment outcome is still unconfirmed. Check its status before starting another publication.",
  vercel_domain_changed: "The project's production domain changed. Restore the original domain in Vercel before publishing again.",
  vercel_domain_pending: "Vercel has not assigned the production domain yet. Check the deployment status again.",
  publish_busy: "Wait for the current publication or app changes to finish before changing these settings.",
  publish_target_locked: "This app already has a Vercel Project. Its Team cannot be changed here.",
  vercel_storage_unavailable: "Publishing is not configured on this builder yet. Please try again later.",
};

async function requireOwner(sessionId: string, userId: string, idle = false) {
  const session = await getSessionMeta(sessionId, { userId });
  if (!session) throw new IntegrationError("App not found.", 404);
  if (idle && ["pending", "running", "cancelling"].includes(session.runStatus)) throw new IntegrationError(PUBLISH_ERRORS.publish_busy, 409, "publish_busy");
  return session;
}

export async function vercelUserToken(userId: string, sessionId: string) {
  const connection = await readVercelConnection(userId);
  if (!connection) throw new IntegrationError(PUBLISH_ERRORS.vercel_not_connected, 409, "vercel_not_connected");
  return (await getAppConnectToken({ connector: connection.connector, subject: "user", scope: "owner" }, userId, sessionId)).token;
}
export async function listPublishTeams(sessionId: string, userId: string) {
  await requireOwner(sessionId, userId);
  return listVercelTeams(await vercelUserToken(userId, sessionId));
}
export async function choosePublishTeam(sessionId: string, userId: string, teamId: string) {
  await requireOwner(sessionId, userId, true);
  const teams = await listPublishTeams(sessionId, userId);
  const selected = teams.find((team) => team.id === teamId);
  if (!selected) throw new IntegrationError("Select a Team your Vercel account can access.", 403, "vercel_permission");
  await selectPublishTeam(sessionId, userId, selected.id, selected.name, selected.slug);
}
export async function disconnectPublishAccount(sessionId: string, userId: string) {
  await requireOwner(sessionId, userId, true);
  await deleteVercelConnection(userId);
}
export async function startVercelPublication(sessionId: string, userId: string) {
  await requireOwner(sessionId, userId, true);
  if (!configuredVercelConnector()) throw new IntegrationError("Vercel connection is not configured.", 503, "vercel_not_connected");
  const target = await readPublishTarget(sessionId, userId);
  if (!target) throw new IntegrationError(PUBLISH_ERRORS.vercel_team_required, 409, "vercel_team_required");
  const token = await vercelUserToken(userId, sessionId);
  if (!(await listVercelTeams(token)).some((team) => team.id === target.team_id)) throw new IntegrationError(PUBLISH_ERRORS.vercel_permission, 403, "vercel_permission");
  const job = await enqueuePublishJob(sessionId, userId);
  const { kickVercelPublishWorkflow } = await import("@/workflow/vercel-publish-kick");
  await kickVercelPublishWorkflow(job);
  return job;
}
export async function resumeVercelPublication(sessionId: string, userId: string) {
  await requireOwner(sessionId, userId);
  const job = await readLatestPublishJob(sessionId, userId);
  if (job?.active) {
    const { kickVercelPublishWorkflow } = await import("@/workflow/vercel-publish-kick");
    await kickVercelPublishWorkflow(job, true);
  }
}

/** No tokens, ciphertext or environment values enter the browser projection. */
export async function getVercelPublishProjection(sessionId: string, userId: string): Promise<Partial<SessionIntegrationsProjection>> {
  const [connection, target, job, legacy] = await Promise.all([
    readVercelConnection(userId), readPublishTarget(sessionId, userId),
    readLatestPublishJob(sessionId, userId), readLegacyPublication(sessionId, userId),
  ]);
  if (job?.active && job.phase !== "uncertain") {
    const { kickVercelPublishWorkflow } = await import("@/workflow/vercel-publish-kick");
    await kickVercelPublishWorkflow(job);
  }
  return {
    vercel: {
      connected: Boolean(connection), teamId: target?.team_id ?? null, teamName: target?.team_name ?? null,
      projectId: target?.project_id ?? null, projectName: target?.project_name ?? null,
      dashboardUrl: target?.project_id ? target.team_slug && target.project_name
        ? `https://vercel.com/${encodeURIComponent(target.team_slug)}/${encodeURIComponent(target.project_name)}`
        : "https://vercel.com/dashboard" : null,
    },
    ...(legacy ? { legacyPublication: { url: legacy.url, updatedAt: legacy.published_at } } : {}),
    ...(job ? { deploy: {
      status: job.active ? "deploying" : job.phase === "READY" ? "live" : "error", provider: "vercel",
      deploymentId: job.deployment_id, url: target?.production_url ?? null, updatedAt: job.updated_at,
      error: job.error_code ? PUBLISH_ERRORS[job.error_code] ?? PUBLISH_ERRORS.vercel_publish_failed : null,
      errorCode: job.error_code, phase: job.phase, logs: job.build_logs,
      sourceSha: job.source_sha, jobId: job.id,
    } } : {}),
  };
}

function retryDelay(job: PublishJob) { return Math.min(60_000, 2_000 * 2 ** Math.min(job.poll_count, 5)); }
function safeErrorCode(error: unknown, projectCreation = false): string {
  if (error instanceof VercelApiError) {
    if (error.status === 401) return "vercel_authorization_required";
    if (error.status === 403) return projectCreation ? "vercel_project_permission" : "vercel_permission";
    if (error.status === 504) return "vercel_network";
  }
  if (error instanceof IntegrationError) {
    if (error.code === "connect_authorization_required") return "vercel_authorization_required";
    if (error.code && Object.hasOwn(PUBLISH_ERRORS, error.code)) return error.code;
  }
  return "vercel_publish_failed";
}
export function redactPublishLogs(text: string, secrets: string[]): string {
  let safe = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  for (const value of secrets.filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([value, encodeURIComponent(value), Buffer.from(value).toString("base64")])) safe = safe.split(variant).join("[REDACTED]");
  }
  return safe.replace(/(?:Bearer\s+)[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+\b|\bwhsec_[A-Za-z0-9]+\b|\b(?:sb_secret_|vcp_|vercel_)[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]").slice(-24_000);
}
async function nullableProject(token: string, job: PublishJob): Promise<VercelProject | null> {
  try { return await getVercelProject(token, job.team_id, job.project_id ?? job.project_name); }
  catch (error) { if (error instanceof VercelApiError && error.status === 404) return null; throw error; }
}
async function release(job: PublishJob, patch: Parameters<typeof patchPublishJob>[1] = {}) {
  return patchPublishJob(job, { ...patch, poll_count: job.poll_count + 1, lease_id: null, lease_until: null });
}

/** One bounded reconciliation pass. Provider mutation intent survives step replay. */
export async function reconcileVercelPublication(id: string, userId: string): Promise<{ done: boolean; delayMs: number }> {
  let job = await claimPublishJob(id, userId, randomUUID());
  if (!job) {
    const current = await readPublishJob(id, userId);
    return { done: !current?.active, delayMs: 15_000 };
  }
  let secrets: string[] = [];
  let mutation: "project" | "deployment" | null = null;
  try {
    await requireOwner(job.session_id, userId);
    const token = await vercelUserToken(userId, job.session_id);
    secrets = [token];
    if (job.phase === "pending" || job.phase === "preparing") {
      job = await patchPublishJob(job, { phase: "preparing" });
      const source = await resolvePublishSource(job.session_id, userId);
      job = await patchPublishJob(job, { repo_id: source.repoId, source_sha: source.sha, phase: "uploading" });
      await release(job);
      return { done: false, delayMs: 1_000 };
    }

    if (!job.project_id) {
      const existing = await nullableProject(token, job);
      if (job.phase === "uploading") {
        if (existing) throw new IntegrationError(PUBLISH_ERRORS.vercel_project_conflict, 409, "vercel_project_conflict");
        job = await patchPublishJob(job, { phase: "creating_project" });
        mutation = "project";
        const created = await createVercelProject(token, job.team_id, job.project_name);
        await bindPublishProject(job, created.id, created.name);
        job = await patchPublishJob(job, { project_id: created.id, phase: "uploading" });
        mutation = null;
      } else if (existing && existing.createdAt && existing.createdAt >= Date.parse(job.created_at) - 5_000) {
        await bindPublishProject(job, existing.id, existing.name);
        job = await patchPublishJob(job, { project_id: existing.id, phase: "uploading", error_code: null });
      } else {
        return await waitForOutcome(job);
      }
      await release(job);
      return { done: false, delayMs: 1_000 };
    }

    if (job.phase === "uploading") {
      const record = await readRuntimeIntegrations(job.session_id);
      const env = record ? buildGeneratedAppEnv(record) : {};
      const projectEnv = await getVercelProjectEnv(token, job.team_id, job.project_id!);
      secrets.push(...Object.values(env), ...projectEnv.flatMap((item) => item.value ? [item.value] : []));
      // Inherit unrelated project settings. Never overwrite a user's conflicting
      // production key; generated values belong to this immutable deployment.
      for (const variable of projectEnv) {
        if ((!variable.target || variable.target.includes("production")) && Object.hasOwn(env, variable.key) && variable.value !== env[variable.key]) {
          throw new IntegrationError(PUBLISH_ERRORS.vercel_env_conflict, 409, "vercel_env_conflict");
        }
      }
      if (!job.repo_id || !job.source_sha) throw new Error("Publication source is missing.");
      const files = await exportPublishSource(job.repo_id, job.source_sha);
      const uploaded = await uploadVercelFiles(token, job.team_id, files);
      job = await patchPublishJob(job, { phase: "submitting" });
      mutation = "deployment";
      const deployment = await createVercelDeployment(token, job.team_id, {
        projectId: job.project_id!, name: job.project_name, files: uploaded, env, jobId: job.id, sourceSha: job.source_sha!,
      });
      job = await patchPublishJob(job, { deployment_id: deployment.id, phase: "QUEUED" });
      mutation = null;
      await release(job);
      return { done: false, delayMs: 2_000 };
    }

    if (!job.deployment_id) {
      const found = await findVercelDeployment(token, job.team_id, job.project_id, job.id);
      if (!found) return await waitForOutcome(job);
      job = await patchPublishJob(job, { deployment_id: found.id, error_code: null });
    }
    const deployment = await getVercelDeployment(token, job.team_id, job.deployment_id!);
    if (deployment.state === "READY") {
      const project = await getVercelProject(token, job.team_id, job.project_id!);
      if (!project.productionDomain) return await waitForOutcome(job, "vercel_domain_pending");
      const url = `https://${project.productionDomain}`;
      const target = await readPublishTarget(job.session_id, userId);
      if (target?.production_url && target.production_url !== url) throw new IntegrationError(PUBLISH_ERRORS.vercel_domain_changed, 409, "vercel_domain_changed");
      job = await patchPublishJob(job, { production_url: url });
      await finishPublishJob(job, true);
      return { done: true, delayMs: 0 };
    }
    if (["ERROR", "CANCELED", "CANCELLED", "BLOCKED"].includes(deployment.state)) {
      // Logs may print app configuration. Resolve current known secrets again,
      // include project values, and scrub them before storing any build output.
      let logs: string | null = null;
      try {
        const runtime = await readRuntimeIntegrations(job.session_id);
        const projectEnv = await getVercelProjectEnv(token, job.team_id, job.project_id!);
        secrets.push(...Object.values(runtime ? buildGeneratedAppEnv(runtime) : {}), ...projectEnv.flatMap((item) => item.value ? [item.value] : []));
        logs = redactPublishLogs(await getVercelBuildLogs(token, job.team_id, job.deployment_id!), secrets);
      } catch { logs = "Build output is unavailable. Open the deployment in Vercel to review its logs."; }
      await finishPublishJob(job, false, "vercel_build_failed", logs);
      return { done: true, delayMs: 0 };
    }
    const phase = ["QUEUED", "INITIALIZING", "BUILDING"].includes(deployment.state) ? deployment.state as "QUEUED" | "INITIALIZING" | "BUILDING" : "QUEUED";
    if (Date.now() - Date.parse(job.created_at) >= DEADLINE_MS) return await waitForOutcome(job);
    await release(job, { phase, error_code: null });
    return { done: false, delayMs: retryDelay(job) };
  } catch (error) {
    if (error instanceof IntegrationError && error.code === "publish_lease_lost") return { done: false, delayMs: 15_000 };
    // Never reissue a POST after a network interruption or lost persistence ack.
    if (mutation && (!(error instanceof VercelApiError) || error.uncertain)) {
      await release(job, { error_code: "vercel_network" });
      return { done: false, delayMs: retryDelay(job) };
    }
    // A known deployment may still finish while authorization/network is down.
    if (job.deployment_id || ["creating_project", "submitting", "uncertain"].includes(job.phase)) {
      if (mutation && error instanceof VercelApiError && !error.uncertain) {
        await finishPublishJob(job, false, safeErrorCode(error, mutation === "project"));
        return { done: true, delayMs: 0 };
      }
      return await waitForOutcome(job, safeErrorCode(error));
    }
    await finishPublishJob(job, false, safeErrorCode(error));
    return { done: true, delayMs: 0 };
  }
}

async function waitForOutcome(job: PublishJob, errorCode?: string): Promise<{ done: boolean; delayMs: number }> {
  const timedOut = Date.now() - Date.parse(job.created_at) >= DEADLINE_MS;
  await release(job, { ...(timedOut ? { phase: "uncertain" as const } : {}), error_code: errorCode ?? (timedOut ? "vercel_publish_timeout" : null) });
  // Keep the active slot when a provider mutation might have succeeded. A manual
  // status reconciliation can recover it without creating another deployment.
  return { done: timedOut, delayMs: retryDelay(job) };
}
