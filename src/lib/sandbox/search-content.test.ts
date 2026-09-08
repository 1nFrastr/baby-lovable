import { describe, expect, it } from "vitest";

import {
  boundContentMatches,
  SEARCH_CONTENT_MAX_MATCHES,
  SEARCH_CONTENT_MAX_SNIPPET_CHARS,
} from "./search-content";
import { workspacePathViolation } from "./protected-paths";

describe("boundContentMatches", () => {
  it("filters protected paths and truncates snippets", () => {
    const long = "a".repeat(SEARCH_CONTENT_MAX_SNIPPET_CHARS + 40);
    const result = boundContentMatches([
      { path: "src/app/page.tsx", line: 3, snippet: "export default function" },
      { path: "node_modules/pkg/index.js", line: 1, snippet: "secret" },
      { path: ".next/server.js", line: 2, snippet: "build" },
      { path: "src/lib/long.ts", line: 9, snippet: `${long}   ` },
    ]);

    expect(result.totalMatches).toBe(2);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toEqual({
      path: "src/app/page.tsx",
      line: 3,
      snippet: "export default function",
    });
    expect(result.matches[1].snippet).toHaveLength(
      SEARCH_CONTENT_MAX_SNIPPET_CHARS + 1,
    );
    expect(result.matches[1].snippet.endsWith("…")).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("caps match count", () => {
    const many = Array.from({ length: SEARCH_CONTENT_MAX_MATCHES + 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      snippet: `hit ${i}`,
    }));
    const result = boundContentMatches(many);
    expect(result.totalMatches).toBe(SEARCH_CONTENT_MAX_MATCHES + 5);
    expect(result.matches).toHaveLength(SEARCH_CONTENT_MAX_MATCHES);
    expect(result.truncated).toBe(true);
  });
});

describe("workspacePathViolation searchContent", () => {
  it("blocks protected directories but allows queries that mention them", () => {
    expect(
      workspacePathViolation("searchContent", "node_modules"),
    ).toMatch(/searchContent is not allowed/);
    expect(
      workspacePathViolation("searchContent", "src", {
        searchPattern: ".next",
      }),
    ).toBeNull();
    expect(workspacePathViolation("searchContent", ".")).toBeNull();
  });

  it("still blocks filename globs that target protected dirs", () => {
    expect(
      workspacePathViolation("search", ".", {
        searchPattern: "node_modules/**",
      }),
    ).toMatch(/searchFiles is not allowed/);
  });
});
