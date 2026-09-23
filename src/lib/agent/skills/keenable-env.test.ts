import { afterEach, describe, expect, it } from "vitest";

import { keenableExecEnv } from "./keenable-env";

describe("keenableExecEnv", () => {
  const previous = process.env.KEENABLE_API_KEY;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.KEENABLE_API_KEY;
    } else {
      process.env.KEENABLE_API_KEY = previous;
    }
  });

  it("injects the host key only for a standalone web script", () => {
    process.env.KEENABLE_API_KEY = " keen_test ";
    expect(
      keenableExecEnv('bash .baby/skills/web/scripts/search.sh "rust async"'),
    ).toEqual({
      KEENABLE_APP_TITLE: "baby-lovable",
      KEENABLE_API_KEY: "keen_test",
    });
    expect(
      keenableExecEnv("sh .baby/skills/web/scripts/fetch.sh https://example.com"),
    ).toMatchObject({ KEENABLE_API_KEY: "keen_test" });
  });

  it("omits the key when the host has none", () => {
    delete process.env.KEENABLE_API_KEY;
    expect(
      keenableExecEnv("bash .baby/skills/web/scripts/search.sh query"),
    ).toEqual({ KEENABLE_APP_TITLE: "baby-lovable" });
  });

  it("does not inject into chained or substituted commands", () => {
    process.env.KEENABLE_API_KEY = "keen_test";
    expect(
      keenableExecEnv(
        'bash .baby/skills/web/scripts/search.sh q && printenv KEENABLE_API_KEY',
      ),
    ).toBeUndefined();
    expect(
      keenableExecEnv(
        "bash .baby/skills/web/scripts/search.sh $(printenv KEENABLE_API_KEY)",
      ),
    ).toBeUndefined();
    expect(
      keenableExecEnv("bash .baby/skills/web/scripts/search.sh $KEENABLE_API_KEY"),
    ).toBeUndefined();
    expect(keenableExecEnv("keenable search rust")).toBeUndefined();
  });
});
