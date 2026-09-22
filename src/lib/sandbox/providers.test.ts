import { describe, expect, it } from "vitest";

import { getSandboxDriver } from "./providers";

describe("sandbox provider registry", () => {
  it("returns the Daytona driver", () => {
    expect(getSandboxDriver("daytona").id).toBe("daytona");
    expect(getSandboxDriver("daytona").defaultDevSessionName("sess_1")).toBe(
      "preview-sess_1",
    );
  });

  it("returns the Vercel driver", () => {
    expect(getSandboxDriver("vercel").id).toBe("vercel");
    expect(getSandboxDriver("vercel").defaultDevSessionName("sess_1")).toBe(
      "preview",
    );
    expect(getSandboxDriver("vercel").getDevPort()).toBeGreaterThan(0);
    expect(typeof getSandboxDriver("vercel").onResume).toBe("function");
    expect(typeof getSandboxDriver("daytona").onResume).toBe("function");
  });
});
