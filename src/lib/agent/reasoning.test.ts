import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_REASONING_EFFORT,
  resolveReasoningEffort,
} from "./reasoning";

describe("resolveReasoningEffort", () => {
  const previous = process.env.AI_REASONING;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.AI_REASONING;
    } else {
      process.env.AI_REASONING = previous;
    }
  });

  it("defaults to low so DeepSeek does not sit on high thinking", () => {
    delete process.env.AI_REASONING;
    expect(resolveReasoningEffort()).toBe(DEFAULT_REASONING_EFFORT);
    expect(resolveReasoningEffort()).toBe("low");
  });

  it("accepts a valid AI_REASONING override", () => {
    process.env.AI_REASONING = "high";
    expect(resolveReasoningEffort()).toBe("high");
  });

  it("ignores unknown values", () => {
    process.env.AI_REASONING = "max";
    expect(resolveReasoningEffort()).toBe("low");
  });
});
