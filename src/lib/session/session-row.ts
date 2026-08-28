import type { SessionRunStatus } from "./types";

export interface SessionRow {
  id: string;
  user_id: string;
  schema_version: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_run_id: string | null;
  run_status: SessionRunStatus;
  active_turn_id: string | null;
  active_assistant_message_id: string | null;
  conversation_revision: number;
  turn_checkpoint: number;
  active_turn_started_at: string | null;
  sandbox_mode: unknown;
  deleted_at: string | null;
}
