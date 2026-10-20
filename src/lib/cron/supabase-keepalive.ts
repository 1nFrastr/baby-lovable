/**
 * Reads that reach Postgres through PostgREST. Empty tables still count:
 * Supabase pauses Free projects for lack of database activity, not for an
 * empty result. Auth health checks do not count.
 */
export const SUPABASE_KEEPALIVE_QUERIES = [
  { table: "sessions", column: "id" },
  { table: "session_messages", column: "message_id" },
  { table: "session_runtime_projection", column: "session_id" },
] as const;

type KeepaliveClient = {
  from: (table: string) => {
    select: (column: string) => {
      limit: (count: number) => PromiseLike<{
        error: { message: string } | null;
      }>;
    };
  };
};

export async function pingSupabase(
  client: KeepaliveClient,
): Promise<{ queries: number }> {
  for (const query of SUPABASE_KEEPALIVE_QUERIES) {
    const { error } = await client.from(query.table).select(query.column).limit(1);
    if (error) {
      throw new Error(`${query.table}: ${error.message}`);
    }
  }

  return { queries: SUPABASE_KEEPALIVE_QUERIES.length };
}
