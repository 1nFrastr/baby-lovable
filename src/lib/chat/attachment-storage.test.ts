import { describe, expect, it } from "vitest";

import { attachmentStoragePath } from "./attachment-storage";

describe("attachmentStoragePath", () => {
  it("nests objects under user / session / attachment id", () => {
    expect(
      attachmentStoragePath({
        userId: "11111111-1111-1111-1111-111111111111",
        sessionId: "sess_abc",
        attachmentId: "att_1",
        filename: "My Shot.PNG",
      }),
    ).toBe(
      "11111111-1111-1111-1111-111111111111/sess_abc/att_1/My_Shot.PNG",
    );
  });
});
