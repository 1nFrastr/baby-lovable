import { describe, expect, it } from "vitest";

import {
  EXPLORER_MAX_LINES,
  buildExplorerTree,
  filterExplorerEntries,
  isExplorerHiddenPath,
  looksBinaryByExtension,
  truncateExplorerContent,
} from "./workspace-explorer";
import type { FileInfo } from "./types";

describe("workspace-explorer", () => {
  it("hides protected and noise paths", () => {
    expect(isExplorerHiddenPath("node_modules/foo")).toBe(true);
    expect(isExplorerHiddenPath(".next/cache")).toBe(true);
    expect(isExplorerHiddenPath("coverage/lcov.info")).toBe(true);
    expect(isExplorerHiddenPath(".env.local")).toBe(true);
    expect(isExplorerHiddenPath("src/app/page.tsx")).toBe(false);
    expect(isExplorerHiddenPath("package.json")).toBe(false);
  });

  it("filters and sorts directory listings", () => {
    const files: FileInfo[] = [
      { name: "page.tsx", path: "src/app/page.tsx", isDir: false, size: 10 },
      { name: "node_modules", path: "node_modules", isDir: true, size: 0 },
      { name: "app", path: "src/app", isDir: true, size: 0 },
      { name: ".DS_Store", path: ".DS_Store", isDir: false, size: 1 },
    ];
    const entries = filterExplorerEntries(files);
    expect(entries.map((e) => e.path)).toEqual(["src/app", "src/app/page.tsx"]);
  });

  it("builds a nested tree in one walk and skips hidden dirs", async () => {
    const listing: Record<string, FileInfo[]> = {
      ".": [
        { name: "src", path: "src", isDir: true, size: 0 },
        { name: "package.json", path: "package.json", isDir: false, size: 12 },
        { name: "node_modules", path: "node_modules", isDir: true, size: 0 },
      ],
      src: [{ name: "app", path: "src/app", isDir: true, size: 0 }],
      "src/app": [
        { name: "page.tsx", path: "src/app/page.tsx", isDir: false, size: 40 },
      ],
      node_modules: [
        {
          name: "left-pad",
          path: "node_modules/left-pad",
          isDir: true,
          size: 0,
        },
      ],
    };

    const result = await buildExplorerTree({
      listFiles: async (path) => listing[path] ?? [],
    });

    expect(result.truncated).toBe(false);
    expect(result.nodeCount).toBe(4);
    expect(result.tree.map((n) => n.path)).toEqual(["src", "package.json"]);
    expect(result.tree[0]?.children?.[0]?.children?.[0]?.path).toBe(
      "src/app/page.tsx",
    );
  });

  it("marks the tree truncated when node cap is hit", async () => {
    const listing: Record<string, FileInfo[]> = {
      ".": Array.from({ length: 5 }, (_, i) => ({
        name: `f${i}.ts`,
        path: `f${i}.ts`,
        isDir: false,
        size: 1,
      })),
    };

    const result = await buildExplorerTree(
      { listFiles: async (path) => listing[path] ?? [] },
      { maxNodes: 3 },
    );

    expect(result.truncated).toBe(true);
    expect(result.nodeCount).toBe(3);
    expect(result.tree).toHaveLength(3);
  });

  it("truncates by line limit", () => {
    const raw = Array.from({ length: EXPLORER_MAX_LINES + 50 }, (_, i) =>
      `line-${i}`,
    ).join("\n");
    const result = truncateExplorerContent(raw);
    expect(result.truncated).toBe(true);
    expect(result.shownLines).toBe(EXPLORER_MAX_LINES);
    expect(result.totalLines).toBe(EXPLORER_MAX_LINES + 50);
    expect(result.content.split("\n")).toHaveLength(EXPLORER_MAX_LINES);
  });

  it("detects binary extensions", () => {
    expect(looksBinaryByExtension("public/logo.png")).toBe(true);
    expect(looksBinaryByExtension("src/app/page.tsx")).toBe(false);
  });
});
