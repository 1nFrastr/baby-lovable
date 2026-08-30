"use client";

import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { isValidElement, type ReactNode } from "react";
import remarkBreaks from "remark-breaks";
import type { Components, PluginConfig, StreamdownProps } from "streamdown";

/**
 * Chat markdown keeps math + CJK. Skip @streamdown/code / mermaid — their
 * default chrome is a bordered card with header/actions; we render plain
 * fenced blocks instead.
 */
export const streamdownPlugins = {
  math,
  cjk,
} as PluginConfig;

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return "";
}

/** Plain fenced / inline code — no card, header, or action buttons. */
const chatMarkdownComponents: Components = {
  code: ({ className, children, node: _node, ...props }) => {
    const isBlock = "data-block" in props;
    if (!isBlock) {
      return (
        <code
          className="rounded-[3px] bg-zinc-100 px-1 py-px font-mono text-[0.84em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
        >
          {children}
        </code>
      );
    }

    const text = extractText(children).replace(/\n$/, "");
    return (
      <pre className="my-2 max-w-full min-w-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
        <code className={className}>{text}</code>
      </pre>
    );
  },
};

/** Shared Streamdown props for chat + reasoning. */
export const streamdownChatProps = {
  plugins: streamdownPlugins,
  controls: false,
  lineNumbers: false,
  remarkPlugins: [remarkBreaks],
  components: chatMarkdownComponents,
  className: "chat-md",
} satisfies Pick<
  StreamdownProps,
  | "plugins"
  | "controls"
  | "lineNumbers"
  | "remarkPlugins"
  | "components"
  | "className"
>;
