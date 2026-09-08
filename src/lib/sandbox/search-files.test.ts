import { describe, expect, it } from "vitest";

import {
  looksLikePathGlob,
  normalizeFilenameSearch,
} from "./search-files";

describe("normalizeFilenameSearch", () => {
  it("leaves a filename glob unchanged", () => {
    expect(normalizeFilenameSearch("src", "*.tsx")).toEqual({
      path: "src",
      pattern: "*.tsx",
      rewritten: false,
    });
    expect(normalizeFilenameSearch(".", "*Button*")).toEqual({
      path: ".",
      pattern: "*Button*",
      rewritten: false,
    });
  });

  it("splits ripgrep-style path globs into path + filename glob", () => {
    expect(normalizeFilenameSearch(".", "src/**/*.tsx")).toEqual({
      path: "src",
      pattern: "*.tsx",
      rewritten: true,
    });
    expect(normalizeFilenameSearch(".", "**/*.svg")).toEqual({
      path: ".",
      pattern: "*.svg",
      rewritten: true,
    });
    expect(normalizeFilenameSearch("src", "**/*.tsx")).toEqual({
      path: "src",
      pattern: "*.tsx",
      rewritten: true,
    });
    expect(normalizeFilenameSearch("src", "components/**/*.tsx")).toEqual({
      path: "src/components",
      pattern: "*.tsx",
      rewritten: true,
    });
  });
});

describe("looksLikePathGlob", () => {
  it("detects path-style patterns the Daytona filename search cannot use", () => {
    expect(looksLikePathGlob("*.tsx")).toBe(false);
    expect(looksLikePathGlob("src/**/*.tsx")).toBe(true);
    expect(looksLikePathGlob("**/*.ts")).toBe(true);
  });
});
