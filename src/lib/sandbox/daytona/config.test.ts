import { afterEach, describe, expect, it } from "vitest";

import { getDaytonaDomainAllowList } from "./config";

describe("getDaytonaDomainAllowList", () => {
  afterEach(() => {
    delete process.env.DAYTONA_FREE_PLAN;
    delete process.env.DAYTONA_DOMAIN_ALLOW_LIST;
  });

  it("omits allow list on free plan (Tier 1–2 cannot override)", () => {
    process.env.DAYTONA_FREE_PLAN = "1";
    process.env.DAYTONA_DOMAIN_ALLOW_LIST = "custom.example.com";
    expect(getDaytonaDomainAllowList()).toBeUndefined();
  });

  it("returns default Freestyle/npm list on pro", () => {
    delete process.env.DAYTONA_FREE_PLAN;
    const list = getDaytonaDomainAllowList();
    expect(list).toContain("git.freestyle.sh");
    expect(list).toContain("registry.npmjs.org");
  });

  it("honors DAYTONA_DOMAIN_ALLOW_LIST on pro", () => {
    process.env.DAYTONA_FREE_PLAN = "0";
    process.env.DAYTONA_DOMAIN_ALLOW_LIST = "only.example.com";
    expect(getDaytonaDomainAllowList()).toBe("only.example.com");
  });
});
