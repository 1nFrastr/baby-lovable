import { describe, expect, it } from "vitest";

import { isTempFailure } from "./preview-errors";

describe("isTempFailure", () => {
  it("does not treat stable HTTP 500 as a transient warm failure", () => {
    expect(
      isTempFailure({
        status: "ready",
        url: "https://preview.example",
        httpStatus: 500,
        buildError: "Error: Failed prop type: href",
      }),
    ).toBe(false);
  });

  it("does not treat bare HTTP 500 as transient either", () => {
    expect(
      isTempFailure({
        status: "ready",
        url: "https://preview.example",
        httpStatus: 500,
        buildError: null,
      }),
    ).toBe(false);
  });

  it("still treats 502 + synthetic message as transient", () => {
    expect(
      isTempFailure({
        status: "ready",
        url: "https://preview.example",
        httpStatus: 502,
        buildError: "Preview returned HTTP 502 but no compile error was captured",
      }),
    ).toBe(true);
  });

  it("treats ready + real compile error as hard fail", () => {
    expect(
      isTempFailure({
        status: "ready",
        url: "https://preview.example",
        httpStatus: 200,
        buildError: "Failed to compile\nModule not found",
      }),
    ).toBe(false);
  });
});
