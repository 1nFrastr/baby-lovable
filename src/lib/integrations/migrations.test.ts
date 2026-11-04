import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildAppMigration } from "./migrations";

// Explicit opt-in; isolated throwaway DB on the project's already running local Docker stack.
const enabled = process.env.BABY_TEST_LOCAL_POSTGRES === "1";
describe.skipIf(!enabled)("generated app migrations on PostgreSQL", () => {
  const database = `baby_backend_test_${randomBytes(6).toString("hex")}`;
  const psql = (query: string, target = database) => execFileSync("docker", [
    "exec", "-i", "supabase_db_workflow-agent-app", "psql", "-U", "postgres", "-d", target,
    "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t",
  ], { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  beforeAll(() => { psql(`CREATE DATABASE ${database};`, "postgres"); });
  afterAll(() => { psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`, "postgres"); });

  it("replays identical migration once and preserves quoted function bodies", () => {
    const sql = `CREATE TABLE public.orders(id int PRIMARY KEY, note text);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
INSERT INTO public.orders VALUES (1, 'customer''s order');
CREATE FUNCTION public.order_count() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.orders $$;`;
    const migration = buildAppMigration("orders_v1", sql);
    psql(migration.query);
    psql(migration.query);
    expect(psql("SELECT public.order_count();").trim()).toBe("1");
    expect(psql("SELECT count(*) FROM baby_backend.migrations;").trim()).toBe("1");
  });

  it("rejects reused names with changed SQL without applying it", () => {
    expect(() => psql(buildAppMigration("orders_v1", "DROP TABLE public.orders;").query)).toThrow();
    expect(psql("SELECT count(*) FROM public.orders;").trim()).toBe("1");
  });

  it("rolls back table creation and ledger together when RLS is missing", () => {
    expect(() => psql(buildAppMigration("unsafe_table", "CREATE TABLE public.unprotected(id int);").query)).toThrow();
    expect(psql("SELECT to_regclass('public.unprotected') IS NULL;").trim()).toBe("t");
    expect(psql("SELECT count(*) FROM baby_backend.migrations WHERE name = 'unsafe_table';").trim()).toBe("0");
  });

  it("rolls back partial DDL if any statement fails", () => {
    expect(() => psql(buildAppMigration("broken_table", "CREATE TABLE public.partial(id int); SELECT no_such_function();").query)).toThrow();
    expect(psql("SELECT to_regclass('public.partial') IS NULL;").trim()).toBe("t");
  });

  it("prevents authenticated apps from reading the private migration ledger", () => {
    expect(() => psql("SET ROLE authenticated; SELECT * FROM baby_backend.migrations;")).toThrow();
  });
});
