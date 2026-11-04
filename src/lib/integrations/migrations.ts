import { createHash } from "node:crypto";

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Runs on the USER'S project through its OAuth connection, never the host DB. */
export function buildAppMigration(name: string, sql: string): { query: string; digest: string } {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name) || !sql.trim() || sql.includes("\0")) throw new Error("Invalid migration");
  const digest = createHash("sha256").update(sql).digest("hex");
  // All migrations for this project serialize. The ledger and DDL commit together.
  const tag = `$baby_${digest.slice(0, 16)}$`;
  if (sql.includes(tag)) throw new Error("Invalid migration delimiter");
  return { digest, query: `
BEGIN;
SET LOCAL statement_timeout = '25s';
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(192837465);
CREATE SCHEMA IF NOT EXISTS baby_backend;
REVOKE ALL ON SCHEMA baby_backend FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS baby_backend.migrations (
  name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON baby_backend.migrations FROM PUBLIC, anon, authenticated;
DO ${tag}
DECLARE previous_digest text;
BEGIN
  SELECT digest INTO previous_digest FROM baby_backend.migrations WHERE name = ${literal(name)};
  IF previous_digest IS NOT NULL THEN
    IF previous_digest <> ${literal(digest)} THEN RAISE EXCEPTION 'Migration name already used with different content'; END IF;
  ELSE
    EXECUTE ${literal(sql)};
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
    ) THEN RAISE EXCEPTION 'Public tables must enable row level security'; END IF;
    INSERT INTO baby_backend.migrations(name, digest) VALUES (${literal(name)}, ${literal(digest)});
  END IF;
END ${tag};
COMMIT;
` };
}

export const INSPECT_APP_SCHEMA = `SELECT t.table_name, t.column_name, t.data_type,
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.table_name) AS policy_count
FROM information_schema.columns t
JOIN pg_namespace n ON n.nspname = t.table_schema
JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
WHERE t.table_schema = 'public' ORDER BY t.table_name, t.ordinal_position LIMIT 500`;
