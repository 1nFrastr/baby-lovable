import { describe, expect, it } from "vitest";

import { preferSessionDetail } from "./conversation-revision";

function detail(conversationRevision: number) {
  return { session: { conversationRevision, messages: [`rev-${conversationRevision}`] } };
}

describe("preferSessionDetail", () => {
  it("keeps the cached session when the response revision is older", () => {
    const current = detail(11);
    expect(preferSessionDetail(current, detail(10))).toBe(current);
  });

  it("accepts an equal or newer revision", () => {
    const current = detail(11);
    const same = detail(11);
    const newer = detail(12);
    expect(preferSessionDetail(current, same)).toBe(same);
    expect(preferSessionDetail(current, newer)).toBe(newer);
  });

  it("accepts the first snapshot", () => {
    const incoming = detail(1);
    expect(preferSessionDetail(undefined, incoming)).toBe(incoming);
  });
});
