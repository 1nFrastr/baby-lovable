import { afterEach, describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { resolveBuilderModelId } from "./builder-model";

const imageUser: UIMessage = {
  id: "u1",
  role: "user",
  parts: [
    { type: "text", text: "what is this" },
    {
      type: "file",
      mediaType: "image/png",
      filename: "shot.png",
      url: "attachment://att_1",
    },
  ],
};

describe("resolveBuilderModelId", () => {
  const previousModel = process.env.AI_MODEL;
  const previousVision = process.env.AI_VISION_MODEL;

  afterEach(() => {
    if (previousModel == null) {
      delete process.env.AI_MODEL;
    } else {
      process.env.AI_MODEL = previousModel;
    }
    if (previousVision == null) {
      delete process.env.AI_VISION_MODEL;
    } else {
      process.env.AI_VISION_MODEL = previousVision;
    }
  });

  it("keeps GLM Flash for both text and image prompts", () => {
    process.env.AI_MODEL = "zai/glm-5.3-flash";
    delete process.env.AI_VISION_MODEL;
    expect(
      resolveBuilderModelId([
        { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]),
    ).toBe("zai/glm-5.3-flash");
    expect(resolveBuilderModelId([imageUser])).toBe("zai/glm-5.3-flash");
  });

  it("keeps the text model when there are no images", () => {
    process.env.AI_MODEL = "deepseek/deepseek-v4-flash";
    delete process.env.AI_VISION_MODEL;
    expect(
      resolveBuilderModelId([
        { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]),
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("switches Flash to the vision sibling when the prompt has images", () => {
    process.env.AI_MODEL = "deepseek/deepseek-v4-flash";
    delete process.env.AI_VISION_MODEL;
    expect(resolveBuilderModelId([imageUser])).toBe(
      "deepseek/deepseek-v4-flash-vision-exp",
    );
  });
});
