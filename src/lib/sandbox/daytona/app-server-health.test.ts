import { describe, expect, it } from "vitest";

import {
  extractCompileError,
  extractPreviewError,
  hasNextAccessLog5xx,
  isApplicationPreviewFailure,
} from "./app-server-health";

const PROP_TYPE_LOG = `
✓ Compiled in 120ms
Error: Failed prop type: The prop 'href' expects a 'string' or 'object' in '<Link>', but got 'undefined' instead.
    at ignore-listed frames { digest: '3103698990E319' }
 GET / 500 in 84ms
 GET / 500 in 84ms
`;

describe("extractPreviewError", () => {
  it("extracts Failed prop type + digest runtime SSR errors", () => {
    const excerpt = extractPreviewError(PROP_TYPE_LOG);
    expect(excerpt).toContain("Failed prop type");
    expect(excerpt).toContain("digest:");
  });

  it("extracts GET / 5xx access lines when no other marker", () => {
    const excerpt = extractPreviewError("ready\n GET / 500 in 12ms\n");
    expect(excerpt).toMatch(/GET\s+\/\s+500/);
  });

  it("still extracts classic compile failures", () => {
    const excerpt = extractPreviewError(
      "Failed to compile\nModule not found: Can't resolve './missing'\n",
    );
    expect(excerpt).toContain("Failed to compile");
  });

  it("ignores [browser] overlay replays", () => {
    expect(
      extractPreviewError(
        "[browser] Error: Failed prop type: The prop 'href'\n",
      ),
    ).toBeNull();
  });
});

describe("extractCompileError", () => {
  it("does not treat Failed prop type as a compile marker", () => {
    expect(extractCompileError(PROP_TYPE_LOG)).toBeNull();
  });
});

describe("isApplicationPreviewFailure", () => {
  it("treats HTTP 500 as an application failure", () => {
    expect(isApplicationPreviewFailure(500, "")).toBe(true);
  });

  it("treats 502 without Next evidence as boot/proxy", () => {
    expect(isApplicationPreviewFailure(502, "Starting...")).toBe(false);
  });

  it("treats 502 with GET 5xx access log as application failure", () => {
    expect(isApplicationPreviewFailure(502, " GET / 500 in 40ms\n")).toBe(true);
  });

  it("detects Next access log 5xx", () => {
    expect(hasNextAccessLog5xx(" GET /foo 500 in 10ms")).toBe(true);
    expect(hasNextAccessLog5xx(" GET / 200 in 10ms")).toBe(false);
  });
});
