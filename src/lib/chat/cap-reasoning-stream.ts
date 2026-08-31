import type { UIMessageChunk } from "ai";

import { REASONING_TEXT_MAX_CHARS } from "@/lib/chat/reasoning-text";

/**
 * Drop reasoning-delta tokens once a part has reached the display cap.
 * Keeps reasoning-start/end so the Thinking row still animates.
 */
export function capReasoningStream(): TransformStream<
  UIMessageChunk,
  UIMessageChunk
> {
  const emittedById = new Map<string, number>();

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === "start" || chunk.type === "finish-step") {
        emittedById.clear();
        controller.enqueue(chunk);
        return;
      }

      if (chunk.type === "reasoning-start") {
        emittedById.set(chunk.id, 0);
        controller.enqueue(chunk);
        return;
      }

      if (chunk.type === "reasoning-end") {
        emittedById.delete(chunk.id);
        controller.enqueue(chunk);
        return;
      }

      if (chunk.type === "reasoning-delta") {
        const used = emittedById.get(chunk.id) ?? 0;
        if (used >= REASONING_TEXT_MAX_CHARS) {
          return;
        }

        const room = REASONING_TEXT_MAX_CHARS - used;
        if (chunk.delta.length <= room) {
          emittedById.set(chunk.id, used + chunk.delta.length);
          controller.enqueue(chunk);
          return;
        }

        emittedById.set(chunk.id, REASONING_TEXT_MAX_CHARS);
        controller.enqueue({
          ...chunk,
          delta: `${chunk.delta.slice(0, room).trimEnd()}…`,
        });
        return;
      }

      controller.enqueue(chunk);
    },
  });
}
