import { afterEach, describe, expect, it } from "vitest";

import { isDaytonaFreePlan } from "./daytona-free-plan";
import { shouldUseFreestyle } from "@/lib/git/freestyle-config";

describe("isDaytonaFreePlan", () => {
  afterEach(() => {
    delete process.env.DAYTONA_FREE_PLAN;
    delete process.env.FREESTYLE_API_KEY;
  });

  it("defaults to pro when unset", () => {
    delete process.env.DAYTONA_FREE_PLAN;
    expect(isDaytonaFreePlan()).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "TRUE", " On "])(
    "enables free plan for %j",
    (value) => {
      process.env.DAYTONA_FREE_PLAN = value;
      expect(isDaytonaFreePlan()).toBe(true);
    },
  );

  it.each(["0", "false", "off", "no", "FALSE"])(
    "keeps pro for %j",
    (value) => {
      process.env.DAYTONA_FREE_PLAN = value;
      expect(isDaytonaFreePlan()).toBe(false);
    },
  );
});

describe("shouldUseFreestyle", () => {
  afterEach(() => {
    delete process.env.DAYTONA_FREE_PLAN;
    delete process.env.FREESTYLE_API_KEY;
  });

  it("is false on free plan even if API key is set", () => {
    process.env.DAYTONA_FREE_PLAN = "1";
    process.env.FREESTYLE_API_KEY = "fs_test_key";
    expect(shouldUseFreestyle()).toBe(false);
  });

  it("is false when pro but key missing", () => {
    process.env.DAYTONA_FREE_PLAN = "0";
    delete process.env.FREESTYLE_API_KEY;
    expect(shouldUseFreestyle()).toBe(false);
  });

  it("is true when pro and key present", () => {
    delete process.env.DAYTONA_FREE_PLAN;
    process.env.FREESTYLE_API_KEY = "fs_test_key";
    expect(shouldUseFreestyle()).toBe(true);
  });
});
