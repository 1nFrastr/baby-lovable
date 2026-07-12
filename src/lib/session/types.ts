import type { UIMessage } from "ai";

import type { SandboxMode } from "@/lib/sandbox/types";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: UIMessage[];
  lastRunId?: string;
  sandboxMode: SandboxMode;
  gitRemote?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  sandboxMode: SandboxMode;
}

export interface CreateSessionInput {
  title?: string;
  sandboxMode?: SandboxMode;
}

export interface UpdateSessionInput {
  title?: string;
  messages?: UIMessage[];
  lastRunId?: string;
  sandboxMode?: SandboxMode;
  gitRemote?: string;
}
