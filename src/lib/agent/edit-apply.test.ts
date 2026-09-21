import { describe, expect, it } from "vitest";

import { applyEdit } from "./edit-apply";

describe("applyEdit", () => {
  it("replaces a unique exact match", () => {
    const result = applyEdit("hello world", "world", "there");
    expect(result).toEqual({
      ok: true,
      content: "hello there",
      replacements: 1,
    });
  });

  it("replaces every occurrence when replaceAll is true", () => {
    const result = applyEdit("foo bar foo", "foo", "baz", true);
    expect(result).toEqual({
      ok: true,
      content: "baz bar baz",
      replacements: 2,
    });
  });

  it("preserves CRLF when oldString is LF", () => {
    const result = applyEdit("hello\r\nworld\r\n", "world", "earth");
    expect(result).toEqual({
      ok: true,
      content: "hello\r\nearth\r\n",
      replacements: 1,
    });
  });

  it("matches when only leading or trailing line whitespace differs", () => {
    const result = applyEdit("  hello\n  world\n", "hello\nworld", "goodbye");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("goodbye\n");
      expect(result.replacements).toBe(1);
    }
  });

  it("matches a block whose indentation is shifted", () => {
    const content = [
      "export function ready() {",
      "    if (ok) {",
      "      return true;",
      "    }",
      "}",
      "",
    ].join("\n");
    const oldString = ["if (ok) {", "  return true;", "}"].join("\n");

    const result = applyEdit(content, oldString, "return ok;");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("return ok;");
      expect(result.content).not.toContain("if (ok)");
    }
  });

  it("matches when internal whitespace is collapsed", () => {
    const result = applyEdit("const   x  =  1;", "const x = 1;", "const x = 2;");
    expect(result).toEqual({
      ok: true,
      content: "const x = 2;",
      replacements: 1,
    });
  });

  it("matches an over-escaped needle against real control characters", () => {
    const result = applyEdit("hello\tworld", "hello\\tworld", "hello\\tthere");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("hello\\tthere");
      expect(result.replacements).toBe(1);
    }
  });

  it("matches a block by first and last line anchors when a middle line drifted", () => {
    const content = [
      "function foo() {",
      "  const value = 1;",
      "  return value;",
      "}",
      "",
    ].join("\n");
    const oldString = [
      "function foo() {",
      "  const value = 2;",
      "  return value;",
      "}",
    ].join("\n");

    const result = applyEdit(content, oldString, "function foo() {\n  return 1;\n}");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("function foo() {\n  return 1;\n}\n");
      expect(result.replacements).toBe(1);
    }
  });

  it("rejects a non-unique match unless replaceAll is set", () => {
    const result = applyEdit("foo bar foo", "foo", "baz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.matches).toBe(2);
      expect(result.error).toContain("multiple locations");
      expect(result.error.toLowerCase()).not.toContain("writefile");
    }
  });

  it("rejects a complete miss without suggesting writeFile", () => {
    const result = applyEdit("hello world", "missing", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("readfile");
      expect(result.error.toLowerCase()).toContain("editfile");
      expect(result.error.toLowerCase()).not.toContain("writefile");
    }
  });

  it("rejects an empty oldString", () => {
    const result = applyEdit("hello", "", "x");
    expect(result).toEqual({
      ok: false,
      error: "oldString must not be empty",
    });
  });
});
