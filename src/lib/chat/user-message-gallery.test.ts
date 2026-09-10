import { describe, expect, it } from "vitest";

import { USER_MESSAGE_IMAGE_TILE_CLASS } from "./user-message-gallery";

describe("user message image gallery", () => {
  it("uses the same 64px square for one or many images", () => {
    expect(USER_MESSAGE_IMAGE_TILE_CLASS).toContain("size-16");
    expect(USER_MESSAGE_IMAGE_TILE_CLASS).toContain("overflow-hidden");
  });
});
