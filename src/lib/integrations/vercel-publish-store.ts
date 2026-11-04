import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import { IntegrationError } from "./errors";

export type PublishPhase = "pending" | "preparing" | "creating_project" | "uploading" | "submitting" | "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "uncertain";
export interface VercelConnection { user_id: string; connector: string }
export interface PublishTarget {
  session_id: string; user_id: string; team_id: string; team_name: string; team_slug?: string | null;
  project_id: string | null; project_name: string | null; production_url: string | null;
}
export interface PublishJob {
  id: string; session_id: string; user_id: string; team_id: string;
  project_id: string | null; project_name: string; repo_id: string | null; source_sha: string | null;
  phase: PublishPhase; active: boolean; deployment_id: string | null; production_url: string | null;
  error_code: string | null; build_logs: string | null; poll_count: number;
  workflow_run_id: string | null; lease_id: string | null; lease_until: string | null;
  created_at: string; updated_at: string;
}

type StorageError = { message?: string } | null;
function check(error: StorageError) {
  if (!error) return;
  for (const code of ["publish_busy", "publish_target_locked", "vercel_not_connected", "vercel_team_required", "publish_not_owned"]) {
    if (error.message?.includes(code)) throw new IntegrationError("Vercel publication settings could not be changed.", 409, code);
  }
  throw new IntegrationError("Publication storage is unavailable. Apply the Vercel publish migration.", 503, "vercel_storage_unavailable");
}

export async function readVercelConnection(userId: string): Promise<VercelConnection | null> {
  const { data, error } = await getSupabaseAdminClient().from("user_vercel_connections").select("user_id, connector").eq("user_id", userId).maybeSingle();
  check(error); return data;
}
export async function saveVercelConnection(userId: string, connector: string) {
  const { error } = await getSupabaseAdminClient().from("user_vercel_connections").upsert({ user_id: userId, connector, updated_at: new Date().toISOString() });
  check(error);
}
export async function deleteVercelConnection(userId: string) {
  const { error } = await getSupabaseAdminClient().rpc("disconnect_vercel_publish", { p_user: userId });
  check(error);
}
export async function readPublishTarget(sessionId: string, userId: string): Promise<PublishTarget | null> {
  const { data, error } = await getSupabaseAdminClient().from("vercel_publish_targets").select("*").eq("session_id", sessionId).eq("user_id", userId).maybeSingle();
  check(error); return data;
}
export async function selectPublishTeam(sessionId: string, userId: string, teamId: string, teamName: string, teamSlug: string) {
  const { error } = await getSupabaseAdminClient().rpc("select_vercel_publish_team", { p_session: sessionId, p_user: userId, p_team: teamId, p_name: teamName, p_slug: teamSlug });
  check(error);
}
export async function enqueuePublishJob(sessionId: string, userId: string): Promise<PublishJob> {
  const { data, error } = await getSupabaseAdminClient().rpc("enqueue_vercel_publish", { p_session: sessionId, p_user: userId });
  check(error); if (!data) throw new Error("Publication reservation is missing.");
  return data as PublishJob;
}
export async function readPublishJob(id: string, userId: string): Promise<PublishJob | null> {
  const { data, error } = await getSupabaseAdminClient().from("vercel_publish_jobs").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  check(error); return data as PublishJob | null;
}
export async function readLatestPublishJob(sessionId: string, userId: string): Promise<PublishJob | null> {
  const { data, error } = await getSupabaseAdminClient().from("vercel_publish_jobs").select("*").eq("session_id", sessionId).eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  check(error); return data as PublishJob | null;
}
export async function claimPublishJob(id: string, userId: string, lease: string): Promise<PublishJob | null> {
  const { data, error } = await getSupabaseAdminClient().rpc("claim_vercel_publish_job", { p_job: id, p_user: userId, p_lease: lease });
  check(error); return (data as PublishJob[] | null)?.[0] ?? null;
}
export async function patchPublishJob(job: PublishJob, patch: Partial<Pick<PublishJob, "phase" | "repo_id" | "source_sha" | "project_id" | "deployment_id" | "production_url" | "poll_count" | "error_code" | "lease_id" | "lease_until">>): Promise<PublishJob> {
  const { data, error } = await getSupabaseAdminClient().from("vercel_publish_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", job.id).eq("user_id", job.user_id)
    .eq("lease_id", job.lease_id!).eq("active", true).select("*").maybeSingle();
  check(error); if (!data) throw new IntegrationError("Another worker owns this publication.", 409, "publish_lease_lost");
  return data as PublishJob;
}
export async function bindPublishProject(job: PublishJob, projectId: string, projectName: string) {
  const { error } = await getSupabaseAdminClient().rpc("bind_vercel_publish_project", { p_job: job.id, p_user: job.user_id, p_lease: job.lease_id, p_project: projectId, p_name: projectName });
  check(error);
}
export async function finishPublishJob(job: PublishJob, success: boolean, errorCode: string | null = null, logs: string | null = null) {
  const { data, error } = await getSupabaseAdminClient().rpc("finish_vercel_publish_job", {
    p_job: job.id, p_user: job.user_id, p_lease: job.lease_id, p_success: success, p_error: errorCode, p_logs: logs,
  });
  check(error); if (!data) throw new IntegrationError("Another worker owns this publication.", 409, "publish_lease_lost");
}
export async function claimPublishWorkflow(job: PublishJob, claim: string) {
  let query = getSupabaseAdminClient().from("vercel_publish_jobs").update({ workflow_run_id: claim }).eq("id", job.id).eq("user_id", job.user_id).eq("active", true);
  query = job.workflow_run_id ? query.eq("workflow_run_id", job.workflow_run_id) : query.is("workflow_run_id", null);
  const { data, error } = await query.select("id").maybeSingle();
  check(error); return Boolean(data);
}
export async function setPublishWorkflow(job: PublishJob, claim: string, runId: string | null) {
  const { error } = await getSupabaseAdminClient().from("vercel_publish_jobs").update({ workflow_run_id: runId }).eq("id", job.id).eq("user_id", job.user_id).eq("workflow_run_id", claim);
  check(error);
}
export async function readLegacyPublication(sessionId: string, userId: string): Promise<{ url: string | null; published_at: string | null } | null> {
  const { data, error } = await getSupabaseAdminClient().from("legacy_freestyle_publications").select("url, published_at").eq("session_id", sessionId).eq("user_id", userId).maybeSingle();
  check(error); return data;
}
