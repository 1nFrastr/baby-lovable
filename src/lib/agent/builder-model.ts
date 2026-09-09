import {
  collectFileParts,
  isImageMediaType,
} from "@/lib/chat/attachments";
import type { UIMessage } from "ai";

/** Default builder / compaction model (Vercel AI Gateway). Native multimodal. */
export const DEFAULT_BUILDER_MODEL = "zai/glm-5.3-flash";

const TEXT_ONLY_FLASH = "deepseek/deepseek-v4-flash";
const DEEPSEEK_VISION_MODEL = "deepseek/deepseek-v4-flash-vision-exp";

export function userPromptHasImages(messages: UIMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      collectFileParts(message).some((part) =>
        isImageMediaType(part.mediaType),
      ),
  );
}

/**
 * GLM 5.3 Flash already sees images. Text-only DeepSeek Flash does not —
 * when the prompt still has user image parts, use its vision sibling unless
 * AI_VISION_MODEL is set.
 */
export function resolveBuilderModelId(messages: UIMessage[]): string {
  const textModel = process.env.AI_MODEL ?? DEFAULT_BUILDER_MODEL;
  if (!userPromptHasImages(messages)) {
    return textModel;
  }
  if (process.env.AI_VISION_MODEL) {
    return process.env.AI_VISION_MODEL;
  }
  if (textModel.includes("vision")) {
    return textModel;
  }
  if (textModel === TEXT_ONLY_FLASH) {
    return DEEPSEEK_VISION_MODEL;
  }
  return textModel;
}
