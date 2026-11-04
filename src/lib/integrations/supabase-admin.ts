import { z } from "zod";

import { SessionAccessDeniedError } from "@/lib/session/auth-context";
import { getSessionMeta } from "@/lib/session/store";
import { getSupabaseUrl } from "@/lib/supabase/config";

import { getSupabaseManagementToken } from "./credentials";
import { IntegrationError } from "./errors";
import { readSessionIntegrations } from "./store";
import { supabaseManagementRequest, SupabaseManagementError } from "./supabase-management";
import type { SupabaseAuthResponse, SupabaseSchemaResponse, SupabaseDatabaseTable, SupabaseTableRowsResponse, SupabaseTableRowsSort, SupabaseUsersResponse } from "./supabase-admin-types";

function validUrl(value: string, allowGlob = false): boolean {
  // Commas delimit Management API redirect entries; controls and credentials
  // would make these settings ambiguous or unsafe to display in the panel.
  if (/[\s,\p{Cc}]/u.test(value) || (!allowGlob && /[*{}[\]]/.test(value))) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export const supabaseAuthPatchSchema = z.strictObject({
  emailConfirmationRequired: z.boolean().optional(),
  signupEnabled: z.boolean().optional(),
  anonymousSignInsEnabled: z.boolean().optional(),
  siteUrl: z.string().max(2048).refine((value) => validUrl(value)).optional(),
  redirectUrls: z.array(z.string().max(2048).refine((value) => validUrl(value, true))).max(100).optional(),
}).refine((value) => Object.keys(value).length > 0);

const authConfigSchema = z.object({
  mailer_autoconfirm: z.boolean(),
  disable_signup: z.boolean(),
  external_anonymous_users_enabled: z.boolean(),
  site_url: z.string(),
  uri_allow_list: z.string().nullable(),
});

function invalidProviderResponse(): never {
  throw new IntegrationError("Supabase returned an invalid administration response.", 502);
}

/** Authenticate before reading integration metadata or obtaining any credentials. */
async function managementContext(sessionId: string, userId: string, mutation = false) {
  if (!userId) throw new SessionAccessDeniedError();
  const session = await getSessionMeta(sessionId, { userId });
  if (!session) throw new IntegrationError("App not found.", 404);
  if (session.userId !== userId) throw new SessionAccessDeniedError();
  if (mutation && ["pending", "running", "cancelling"].includes(session.runStatus)) {
    throw new IntegrationError("Wait for the current app changes to finish.", 409, "supabase_admin_busy");
  }
  // Management access needs no runtime secrets, even for a manually linked app.
  const record = await readSessionIntegrations(sessionId, false);
  if (record && (record.userId !== userId || record.sessionId !== sessionId)) throw new SessionAccessDeniedError();
  if (record?.supabaseStatus !== "linked" || !record.supabaseProjectRef || !record.supabaseProjectUrl) {
    throw new IntegrationError("Link a Supabase project first.", 409, "supabase_admin_unlinked");
  }
  const ref = record.supabaseProjectRef;
  if (!/^[a-z0-9]{1,63}$/.test(ref) || record.supabaseProjectUrl !== `https://${ref}.supabase.co`) {
    throw new IntegrationError("Reconnect the Supabase project.", 409, "supabase_admin_reconnect");
  }
  // A persisted binding must never allow administration of the host metadata DB.
  const hostUrl = getSupabaseUrl();
  if (hostUrl && new URL(hostUrl).hostname === `${ref}.supabase.co`) {
    throw new IntegrationError("Choose a separate app project.", 400, "supabase_admin_host_project");
  }
  if (record.supabaseLinkMethod !== "connect" || !record.supabaseConnectConnector) {
    throw new IntegrationError("Reconnect Supabase through Connect for administration.", 409, "supabase_admin_reconnect");
  }
  return { record, path: `/projects/${ref}` };
}

async function readAuth(token: string, path: string): Promise<SupabaseAuthResponse> {
  const parsed = authConfigSchema.safeParse(await supabaseManagementRequest(token, `${path}/config/auth`));
  if (!parsed.success) invalidProviderResponse();
  const config = parsed.data;
  // Select only panel settings. The provider response also contains secrets.
  return { settings: {
    emailConfirmationRequired: !config.mailer_autoconfirm,
    signupEnabled: !config.disable_signup,
    anonymousSignInsEnabled: config.external_anonymous_users_enabled,
    siteUrl: config.site_url,
    redirectUrls: (config.uri_allow_list ?? "").split(",").map((url) => url.trim()).filter(Boolean),
  } };
}

export async function getSessionSupabaseAuth(sessionId: string, userId: string): Promise<SupabaseAuthResponse> {
  const { record, path } = await managementContext(sessionId, userId);
  return readAuth(await getSupabaseManagementToken(record), path);
}

export async function patchSessionSupabaseAuth(sessionId: string, userId: string, input: unknown): Promise<SupabaseAuthResponse> {
  const { record, path } = await managementContext(sessionId, userId, true);
  const parsed = supabaseAuthPatchSchema.safeParse(input);
  if (!parsed.success) throw new IntegrationError("Invalid authentication settings.", 400, "supabase_admin_invalid_settings");
  const settings = parsed.data;
  const body: Record<string, unknown> = {};
  if (settings.emailConfirmationRequired !== undefined) body.mailer_autoconfirm = !settings.emailConfirmationRequired;
  if (settings.signupEnabled !== undefined) body.disable_signup = !settings.signupEnabled;
  if (settings.anonymousSignInsEnabled !== undefined) body.external_anonymous_users_enabled = settings.anonymousSignInsEnabled;
  if (settings.siteUrl !== undefined) body.site_url = settings.siteUrl;
  if (settings.redirectUrls !== undefined) body.uri_allow_list = settings.redirectUrls.join(",");
  const token = await getSupabaseManagementToken(record);
  await supabaseManagementRequest(token, `${path}/config/auth`, { method: "PATCH", body });
  // Read back the full configuration, including fields absent from a partial PATCH.
  return readAuth(token, path);
}

/** Fixed catalog query: public and custom app schemas, excluding Supabase internals.
 * No app rows, estimated row counts, submitted SQL, or client-selected identifiers.
 */
export const SUPABASE_APP_SCHEMA_QUERY = `
SELECT ns.nspname AS schema, tbl.relname AS name, tbl.relrowsecurity AS rls_enabled,
  attr.attname AS column_name, pg_catalog.format_type(attr.atttypid, attr.atttypmod) AS data_type,
  NOT attr.attnotnull AS nullable,
  pg_catalog.pg_get_expr(def.adbin, def.adrelid) AS default_value,
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint pk
    WHERE pk.conrelid = tbl.oid AND pk.contype = 'p' AND attr.attnum = ANY(pk.conkey)) AS primary_key,
  ref.schema AS reference_schema, ref.name AS reference_table, ref.column_name AS reference_column
FROM pg_catalog.pg_class tbl
JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
LEFT JOIN pg_catalog.pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum > 0 AND NOT attr.attisdropped
LEFT JOIN pg_catalog.pg_attrdef def ON def.adrelid = tbl.oid AND def.adnum = attr.attnum
LEFT JOIN LATERAL (
  SELECT target_ns.nspname AS schema, target.relname AS name, target_attr.attname AS column_name
  FROM pg_catalog.pg_constraint fk
  JOIN pg_catalog.pg_class target ON target.oid = fk.confrelid
  JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
  JOIN pg_catalog.pg_attribute target_attr ON target_attr.attrelid = target.oid
    AND target_attr.attnum = fk.confkey[pg_catalog.array_position(fk.conkey, attr.attnum)]
  WHERE fk.conrelid = tbl.oid AND fk.contype = 'f' AND attr.attnum = ANY(fk.conkey)
  ORDER BY fk.oid LIMIT 1
) ref ON true
WHERE tbl.relkind IN ('r', 'p') AND ns.nspname !~ '^pg_'
  AND ns.nspname NOT IN ('information_schema', 'auth', 'storage', 'realtime', 'extensions',
    'vault', 'graphql', 'graphql_public', 'supabase_functions', 'supabase_migrations',
    '_analytics', '_realtime', 'net', 'pgbouncer', 'cron', 'baby_backend')
ORDER BY ns.nspname, tbl.relname, attr.attnum`;

const schemaRowsSchema = z.array(z.object({
  schema: z.string(), name: z.string(), rls_enabled: z.boolean(),
  column_name: z.string().nullable(), data_type: z.string().nullable(), nullable: z.boolean().nullable(),
  default_value: z.string().nullable(), primary_key: z.boolean(),
  reference_schema: z.string().nullable(), reference_table: z.string().nullable(), reference_column: z.string().nullable(),
}));

/** Never accepts caller-provided SQL; callers build only catalog or validated SELECTs. */
async function readOnlyQuery(token: string, path: string, query: string): Promise<unknown> {
  try {
    return await supabaseManagementRequest(token, `${path}/database/query`, {
      method: "POST", body: { query, read_only: true },
    });
  } catch (error) {
    // Paused databases reject even SELECT 1 with HTTP 400. Check lifecycle
    // metadata only after that failure; never inspect or expose provider bodies.
    if (error instanceof SupabaseManagementError && error.status === 400) {
      const project = await supabaseManagementRequest<{ status?: unknown }>(token, path).catch(() => null);
      if (project?.status === "INACTIVE") {
        throw new IntegrationError("The app's Supabase project is paused.", 409, "supabase_admin_project_inactive");
      }
    }
    throw error;
  }
}

async function readSchema(token: string, path: string): Promise<SupabaseSchemaResponse> {
  const parsed = schemaRowsSchema.safeParse(await readOnlyQuery(token, path, SUPABASE_APP_SCHEMA_QUERY));
  if (!parsed.success) invalidProviderResponse();
  const tables = new Map<string, SupabaseDatabaseTable>();
  for (const row of parsed.data) {
    const key = JSON.stringify([row.schema, row.name]);
    let table = tables.get(key);
    if (!table) {
      table = { schema: row.schema, name: row.name, rlsEnabled: row.rls_enabled, columns: [] };
      tables.set(key, table);
    }
    if (row.column_name === null) continue;
    if (row.data_type === null || row.nullable === null) invalidProviderResponse();
    table.columns.push({
      name: row.column_name, dataType: row.data_type, nullable: row.nullable,
      defaultValue: row.default_value, primaryKey: row.primary_key,
      references: row.reference_schema !== null && row.reference_table !== null && row.reference_column !== null
        ? { schema: row.reference_schema, table: row.reference_table, column: row.reference_column }
        : null,
    });
  }
  return { tables: [...tables.values()] };
}

export async function getSessionSupabaseSchema(sessionId: string, userId: string): Promise<SupabaseSchemaResponse> {
  const { record, path } = await managementContext(sessionId, userId);
  return readSchema(await getSupabaseManagementToken(record), path);
}

const identifierSchema = z.string().min(1).max(128).refine((value) => !value.includes("\0"));
const filterSchema = z.union([
  z.strictObject({
    column: identifierSchema,
    operator: z.enum(["contains", "equals", "not_equals"]),
    value: z.string().max(2000).refine((value) => !value.includes("\0")),
  }),
  z.strictObject({ column: identifierSchema, operator: z.enum(["is_null", "is_not_null"]) }),
]);

export const supabaseTableRowsRequestSchema = z.strictObject({
  schema: identifierSchema,
  table: identifierSchema,
  offset: z.number().int().min(0).max(100_000).default(0),
  pageSize: z.number().int().min(1).max(100).default(25),
  sort: z.strictObject({ column: identifierSchema, direction: z.enum(["asc", "desc"]) }).optional(),
  filter: filterSchema.optional(),
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** E literals are independent of the database's standard_conforming_strings setting. */
function quoteLiteral(value: string): string {
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

const usersRequestSchema = z.strictObject({
  offset: z.number().int().min(0).max(100_000).default(0),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).refine((value) => !value.includes("\0")).default(""),
});

const authUsersSchema = z.array(z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  email_confirmed_at: z.string().nullable(),
  created_at: z.string().nullable(),
  last_sign_in_at: z.string().nullable(),
  is_anonymous: z.boolean(),
}));

/** A fixed projection of Auth users; never return password hashes, tokens, or metadata. */
export async function getSessionSupabaseUsers(sessionId: string, userId: string, input: unknown): Promise<SupabaseUsersResponse> {
  const { record, path } = await managementContext(sessionId, userId);
  const parsed = usersRequestSchema.safeParse(input);
  if (!parsed.success) throw new IntegrationError("Invalid user search or pagination.", 400, "supabase_admin_invalid_users");
  const { offset, pageSize, search } = parsed.data;
  const token = await getSupabaseManagementToken(record);
  const pattern = quoteLiteral(`%${search.replace(/[\\%_]/g, (value) => `\\${value}`)}%`);
  const searchSql = search ? ` AND (app_user.email ILIKE ${pattern} ESCAPE ${quoteLiteral("\\")} OR app_user.id::text ILIKE ${pattern} ESCAPE ${quoteLiteral("\\")})` : "";
  const query = `SELECT app_user.id::text AS id, app_user.email, app_user.email_confirmed_at, app_user.created_at, app_user.last_sign_in_at, app_user.is_anonymous FROM auth.users AS app_user WHERE app_user.deleted_at IS NULL${searchSql} ORDER BY app_user.created_at DESC NULLS LAST, app_user.id ASC LIMIT ${pageSize + 1} OFFSET ${offset}`;
  const result = authUsersSchema.max(pageSize + 1).safeParse(await readOnlyQuery(token, path, query));
  if (!result.success) invalidProviderResponse();
  return {
    users: result.data.slice(0, pageSize).map((user) => ({
      id: user.id,
      email: user.email,
      emailConfirmedAt: user.email_confirmed_at,
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at,
      isAnonymous: user.is_anonymous,
    })),
    hasMore: result.data.length > pageSize,
    offset,
    pageSize,
  };
}

function invalidRowsRequest(): never {
  throw new IntegrationError("Invalid database table request.", 400, "supabase_admin_invalid_rows");
}

/** Owner-only administrative data access. App RLS does not restrict these results. */
export async function getSessionSupabaseTableRows(sessionId: string, userId: string, input: unknown): Promise<SupabaseTableRowsResponse> {
  const { record, path } = await managementContext(sessionId, userId);
  const parsed = supabaseTableRowsRequestSchema.safeParse(input);
  if (!parsed.success) invalidRowsRequest();
  const request = parsed.data;
  const token = await getSupabaseManagementToken(record);
  const { tables } = await readSchema(token, path);
  const table = tables.find((item) => item.schema === request.schema && item.name === request.table);
  if (!table) invalidRowsRequest();
  const columns = new Set(table.columns.map((column) => column.name));
  if ((request.sort && !columns.has(request.sort.column)) || (request.filter && !columns.has(request.filter.column))) invalidRowsRequest();

  const orderBy: SupabaseTableRowsSort[] = request.sort ? [request.sort] : [];
  for (const column of table.columns.filter((column) => column.primaryKey)) {
    if (!orderBy.some((sort) => sort.column === column.name)) orderBy.push({ column: column.name, direction: "asc" });
  }
  const orderSql = orderBy.map(({ column, direction }) => `to_jsonb(app_row.${quoteIdentifier(column)}) ${direction.toUpperCase()} NULLS LAST`);
  // tableoid + ctid disambiguate equal values across partitions and tables without PKs.
  orderSql.push("app_row.tableoid ASC", "app_row.ctid ASC");

  let where = "";
  const filter = request.filter;
  if (filter) {
    const expression = `app_row.${quoteIdentifier(filter.column)}`;
    if (filter.operator === "is_null" || filter.operator === "is_not_null") {
      where = `${expression} IS ${filter.operator === "is_not_null" ? "NOT " : ""}NULL`;
    } else if (filter.operator === "contains") {
      const pattern = `%${filter.value.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
      where = `${expression}::text ILIKE ${quoteLiteral(pattern)} ESCAPE ${quoteLiteral("\\")}`;
    } else if (filter.operator === "equals" || filter.operator === "not_equals") {
      where = `${expression}::text ${filter.operator === "equals" ? "=" : "<>"} ${quoteLiteral(filter.value)}`;
    }
  }

  // Build values independently so numeric precision survives JSON parsing and
  // tables with more than PostgreSQL's 100 function-argument limit still work.
  const cells = table.columns.map((column) => {
    const expression = `app_row.${quoteIdentifier(column.name)}`;
    const preciseNumeric = /^(?:bigint|numeric|decimal)(?:\([0-9, ]+\))?$/.test(column.dataType);
    return `(${quoteLiteral(column.name)}, to_jsonb(${expression}${preciseNumeric ? "::text" : ""}))`;
  });
  const rowExpression = cells.length
    ? `(SELECT jsonb_object_agg(cell.name, cell.value) FROM (VALUES ${cells.join(", ")}) AS cell(name, value))`
    : "'{}'::jsonb";
  const query = `SELECT ${rowExpression} AS row FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} AS app_row${where ? ` WHERE ${where}` : ""} ORDER BY ${orderSql.join(", ")} LIMIT ${request.pageSize + 1} OFFSET ${request.offset}`;
  const result = await readOnlyQuery(token, path, query);
  const resultSchema = z.array(z.object({ row: z.record(z.string(), z.unknown()) })).max(request.pageSize + 1);
  const rows = resultSchema.safeParse(result);
  if (!rows.success) invalidProviderResponse();
  return {
    rows: rows.data.slice(0, request.pageSize).map(({ row }) => row),
    hasMore: rows.data.length > request.pageSize,
    offset: request.offset,
    pageSize: request.pageSize,
    orderBy,
  };
}
