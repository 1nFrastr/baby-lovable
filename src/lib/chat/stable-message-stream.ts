import type { UIMessageChunk } from "ai";

/** Bind every consumer of a workflow stream to the turn's stable assistant id. */
export function bindAssistantMessageId(
  assistantMessageId: string,
): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      controller.enqueue(
        chunk.type === "start"
          ? { ...chunk, messageId: assistantMessageId }
          : chunk,
      );
    },
  });
}
