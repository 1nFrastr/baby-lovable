import type { UIMessage } from "ai";

import {
  compactSessionMessages,
  type CompactionPersistMode,
} from "@/lib/chat/run-compaction";

export type { CompactionPersistMode };

export async function ensureCompactionStep(
  sessionId: string,
  turnId: string,
  messages: UIMessage[],
  persistMode: CompactionPersistMode,
): Promise<UIMessage[]> {
  "use step";

  const result = await compactSessionMessages({
    sessionId,
    turnId,
    messages,
    persistMode,
  });
  return result.ok ? result.messages : messages;
}
