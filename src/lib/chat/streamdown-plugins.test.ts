import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";

import { streamdownChatProps } from "./streamdown-plugins";

const tableMarkdown = `关于 harness：

| 项目 | 开源情况 |
| --- | --- |
| OpenAI Codex | CLI 核心全开源 |
| pi | MIT |

单行换行
仍在同一段。
`;

describe("streamdownChatProps", () => {
  it("renders GFM tables and keeps single-newline breaks", () => {
    const html = renderToStaticMarkup(
      createElement(Streamdown, { ...streamdownChatProps, mode: "static" }, tableMarkdown),
    );

    expect(html).toContain("<table");
    expect(html).toContain("OpenAI Codex");
    expect(html).toContain("开源情况");
    expect(html).not.toContain("| --- |");
    expect(html).toContain("<br");
    expect(html).toContain("单行换行");
  });
});
