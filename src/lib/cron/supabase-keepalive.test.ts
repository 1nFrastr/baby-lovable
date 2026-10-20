import { describe, expect, it } from "vitest";

import { pingSupabase, SUPABASE_KEEPALIVE_QUERIES } from "./supabase-keepalive";

function clientRecording(errorFor?: string) {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      return {
        select(column: string) {
          return {
            limit(count: number) {
              calls.push(`${table}.${column}:${count}`);
              return Promise.resolve({
                error: table === errorFor ? { message: "relation missing" } : null,
              });
            },
          };
        },
      };
    },
  };
}

describe("pingSupabase", () => {
  it("reads each existing table once", async () => {
    const client = clientRecording();
    const result = await pingSupabase(client);

    expect(result.queries).toBe(SUPABASE_KEEPALIVE_QUERIES.length);
    expect(client.calls).toEqual([
      "sessions.id:1",
      "session_messages.message_id:1",
      "session_runtime_projection.session_id:1",
    ]);
  });

  it("fails when a query does not reach the database", async () => {
    const client = clientRecording("session_messages");
    await expect(pingSupabase(client)).rejects.toThrow(
      "session_messages: relation missing",
    );
  });
});
