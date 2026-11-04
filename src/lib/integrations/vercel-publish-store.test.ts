import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

const enabled = process.env.BABY_TEST_LOCAL_POSTGRES === "1";
// Every scenario uses the migrated local Docker database and rolls back all rows.
describe.skipIf(!enabled)("Vercel publish transactions on local PostgreSQL", () => {
  function transaction(assertions: string) {
    const owner = randomUUID(); const other = randomUUID();
    return execFileSync("docker", ["exec", "-i", "supabase_db_workflow-agent-app", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      input: `begin;
insert into auth.users(id) values('${owner}'),('${other}');
insert into public.sessions(id, user_id) values('publish-test', '${owner}');
insert into public.user_vercel_connections(user_id, connector) values('${owner}', 'vercel/test');
select public.select_vercel_publish_team('publish-test','${owner}','team_selected','Selected');
do $test$ declare owner_id uuid := '${owner}'; other_id uuid := '${other}'; a public.vercel_publish_jobs; b public.vercel_publish_jobs; lease uuid := gen_random_uuid(); success boolean;
begin ${assertions} end $test$;
rollback;`,
    });
  }
  it("reserves one active job and returns it for repeated clicks", () => {
    expect(() => transaction(`
a := public.enqueue_vercel_publish('publish-test', owner_id);
b := public.enqueue_vercel_publish('publish-test', owner_id);
if a.id <> b.id or (select count(*) from public.vercel_publish_jobs where session_id = 'publish-test') <> 1 then raise exception 'duplicate job'; end if;
if a.team_id <> 'team_selected' then raise exception 'wrong team'; end if;
`)).not.toThrow();
  });
  it("rejects a different owner and prevents Team changes during publication", () => {
    expect(() => transaction(`
begin perform public.enqueue_vercel_publish('publish-test', other_id); raise exception 'accepted foreign owner'; exception when others then if sqlerrm <> 'publish_not_owned' then raise; end if; end;
a := public.enqueue_vercel_publish('publish-test', owner_id);
begin perform public.select_vercel_publish_team('publish-test', owner_id, 'team_other', 'Other'); raise exception 'changed active target'; exception when others then if sqlerrm <> 'publish_busy' then raise; end if; end;
`)).not.toThrow();
  });
  it("fences stale workers and atomically commits the stable production URL", () => {
    expect(() => transaction(`
a := public.enqueue_vercel_publish('publish-test', owner_id);
select * into b from public.claim_vercel_publish_job(a.id, owner_id, lease);
if b.id is null then raise exception 'lease not acquired'; end if;
if exists(select 1 from public.claim_vercel_publish_job(a.id, owner_id, gen_random_uuid())) then raise exception 'double lease'; end if;
perform public.bind_vercel_publish_project(a.id, owner_id, lease, 'prj_app', a.project_name);
update public.vercel_publish_jobs set production_url = 'https://stable.vercel.app', deployment_id = 'dpl_ready' where id = a.id;
success := public.finish_vercel_publish_job(a.id, owner_id, gen_random_uuid(), true, null, null);
if success then raise exception 'accepted stale lease'; end if;
success := public.finish_vercel_publish_job(a.id, owner_id, lease, true, null, null);
if not success then raise exception 'finish rejected'; end if;
if (select production_url from public.vercel_publish_targets where session_id = 'publish-test') <> 'https://stable.vercel.app' then raise exception 'target not committed'; end if;
if (select deploy_url from public.session_integrations where session_id = 'publish-test') <> 'https://stable.vercel.app' then raise exception 'runtime URL not committed'; end if;
begin perform public.select_vercel_publish_team('publish-test', owner_id, 'team_other', 'Other'); raise exception 'changed bound team'; exception when others then if sqlerrm <> 'publish_target_locked' then raise; end if; end;
`)).not.toThrow();
  });
  it("retains the previous live URL after a failed update and allows a new job", () => {
    expect(() => transaction(`
insert into public.session_integrations(session_id,user_id,deploy_provider,deploy_status,deploy_url) values('publish-test',owner_id,'vercel','live','https://stable.vercel.app');
a := public.enqueue_vercel_publish('publish-test', owner_id);
perform public.claim_vercel_publish_job(a.id, owner_id, lease);
perform public.finish_vercel_publish_job(a.id, owner_id, lease, false, 'vercel_build_failed', 'Compile error');
if (select deploy_url from public.session_integrations where session_id = 'publish-test') <> 'https://stable.vercel.app' then raise exception 'lost live URL'; end if;
b := public.enqueue_vercel_publish('publish-test', owner_id);
if a.id = b.id then raise exception 'did not create next job'; end if;
`)).not.toThrow();
  });
  it("blocks account disconnect while a user's publication is active", () => {
    expect(() => transaction(`
a := public.enqueue_vercel_publish('publish-test', owner_id);
begin perform public.disconnect_vercel_publish(owner_id); raise exception 'disconnected active publisher'; exception when others then if sqlerrm <> 'publish_busy' then raise; end if; end;
`)).not.toThrow();
  });
  it("keeps connections, jobs and RPCs inaccessible to browser database roles", () => {
    expect(() => transaction(`
if has_table_privilege('authenticated','public.user_vercel_connections','SELECT') or has_table_privilege('authenticated','public.vercel_publish_jobs','SELECT') or has_function_privilege('authenticated','public.enqueue_vercel_publish(text,uuid)','EXECUTE') then raise exception 'browser privilege leak'; end if;
`)).not.toThrow();
  });
});
