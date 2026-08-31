import { describe, expect, it } from "vitest";

import { sanitizeJsonbText, sanitizeJsonbValue } from "./sanitize-jsonb";

describe("sanitizeJsonbText", () => {
  it("drops NUL bytes that Postgres jsonb rejects", () => {
    expect(sanitizeJsonbText("ok\u0000nope")).toBe("oknope");
    expect(JSON.stringify(sanitizeJsonbText("a\u0000b"))).not.toContain(
      "\\u0000",
    );
  });

  it("leaves CJK and ascii unchanged", () => {
    expect(sanitizeJsonbText("随便做个网站 hello")).toBe("随便做个网站 hello");
  });

  it("drops unpaired surrogates but keeps a complete emoji in one string", () => {
    expect(sanitizeJsonbText("\uD83D")).toBe("");
    expect(sanitizeJsonbText("\uDE00")).toBe("");
    expect(sanitizeJsonbText("ok\uD83D\uDE00end")).toBe("ok😀end");
    expect(sanitizeJsonbText("ok😀end")).toBe("ok😀end");
  });

  it("preserves an emoji if halves are joined before sanitize", () => {
    const joined = "hello" + "\uD83D" + "\uDE00" + "world";
    expect(sanitizeJsonbText(joined)).toBe("hello😀world");
  });

  it("drops both halves if each fragment is sanitized on its own", () => {
    const first = sanitizeJsonbText("hello\uD83D");
    const second = sanitizeJsonbText("\uDE00world");
    expect(first + second).toBe("helloworld");
  });
});

describe("sanitizeJsonbValue", () => {
  it("walks nested objects and arrays", () => {
    expect(
      sanitizeJsonbValue({
        commitMessage: "turn-1: hi\u0000",
        lastError: "push \uD800 failed",
        files: ["src/app/page.tsx"],
      }),
    ).toEqual({
      commitMessage: "turn-1: hi",
      lastError: "push  failed",
      files: ["src/app/page.tsx"],
    });
  });

  it("does not stringify unpaired surrogates into jsonb-illegal escapes", () => {
    const cleaned = sanitizeJsonbValue({ text: "x\uD83D\uDE00y\u0000z" });
    expect(JSON.stringify(cleaned)).toBe('{"text":"x😀yz"}');
    expect(JSON.stringify(cleaned)).not.toMatch(/\\u0000|\\ud8/i);
  });
});
