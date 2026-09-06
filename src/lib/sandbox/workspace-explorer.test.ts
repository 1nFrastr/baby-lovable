import { describe, expect, it } from "vitest";

import {
  EXPLORER_MAX_IMAGE_BYTES,
  EXPLORER_MAX_LINES,
  buildExplorerTree,
  explorerImageMimeType,
  explorerImageResult,
  filterExplorerEntries,
  isExplorerHiddenPath,
  looksBinaryByExtension,
  looksImageByExtension,
  looksSvgByExtension,
  parseSvgDisplaySize,
  truncateExplorerContent,
} from "./workspace-explorer";
import type { FileInfo } from "./types";

describe("workspace-explorer", () => {
  it("hides protected and noise paths", () => {
    expect(isExplorerHiddenPath("node_modules/foo")).toBe(true);
    expect(isExplorerHiddenPath(".next/cache")).toBe(true);
    expect(isExplorerHiddenPath("coverage/lcov.info")).toBe(true);
    expect(isExplorerHiddenPath(".env.local")).toBe(true);
    expect(isExplorerHiddenPath(".env.prod")).toBe(true);
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
    expect(looksBinaryByExtension("public/fonts/inter.woff2")).toBe(true);
    expect(looksBinaryByExtension("archive.zip")).toBe(true);
    expect(looksBinaryByExtension("src/app/page.tsx")).toBe(false);
  });

  it("detects previewable image extensions including svg", () => {
    expect(looksImageByExtension("public/logo.png")).toBe(true);
    expect(looksImageByExtension("public/hero.JPEG")).toBe(true);
    expect(looksImageByExtension("public/icon.svg")).toBe(true);
    expect(looksImageByExtension("public/mark.webp")).toBe(true);
    expect(looksImageByExtension("src/app/page.tsx")).toBe(false);
    expect(looksBinaryByExtension("public/logo.png")).toBe(false);
    expect(looksBinaryByExtension("public/icon.svg")).toBe(false);
    expect(explorerImageMimeType("assets/logo.svg")).toBe("image/svg+xml");
    expect(explorerImageMimeType("assets/photo.jpg")).toBe("image/jpeg");
    expect(looksSvgByExtension("public/icon.svg")).toBe(true);
    expect(looksSvgByExtension("public/logo.png")).toBe(false);
  });

  it("builds an image preview payload and clears content when truncated", () => {
    const ok = explorerImageResult({
      path: "public/logo.png",
      mimeType: "image/png",
      encoding: "base64",
      content: "aaaa",
      byteLength: 3,
    });
    expect(ok).toMatchObject({
      kind: "image",
      binary: false,
      encoding: "base64",
      content: "aaaa",
      truncated: false,
    });

    const tooLarge = explorerImageResult({
      path: "public/hero.png",
      mimeType: "image/png",
      encoding: "base64",
      content: "aaaa",
      byteLength: EXPLORER_MAX_IMAGE_BYTES + 1,
      truncated: true,
    });
    expect(tooLarge.content).toBe("");
    expect(tooLarge.truncated).toBe(true);
    expect(tooLarge.maxBytes).toBe(EXPLORER_MAX_IMAGE_BYTES);
  });

  it("parses SVG preview size from width/height or viewBox", () => {
    expect(
      parseSvgDisplaySize(
        `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"></svg>`,
      ),
    ).toEqual({ width: 24, height: 24 });

    expect(
      parseSvgDisplaySize(
        `<svg viewBox="0 0 394 80" fill="none" xmlns="http://www.w3.org/2000/svg"></svg>`,
      ),
    ).toEqual({ width: 394, height: 80 });

    expect(
      parseSvgDisplaySize(
        `<svg viewBox="0,0,32,16" xmlns="http://www.w3.org/2000/svg"></svg>`,
      ),
    ).toEqual({ width: 32, height: 16 });

    expect(
      parseSvgDisplaySize(
        `<svg width="100%" height="100%" viewBox="0 0 48 24" xmlns="http://www.w3.org/2000/svg"></svg>`,
      ),
    ).toEqual({ width: 48, height: 24 });

    expect(
      parseSvgDisplaySize(`<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 16 8"
></svg>`),
    ).toEqual({ width: 16, height: 8 });

    expect(
      parseSvgDisplaySize(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
    ).toBeNull();
  });
});
