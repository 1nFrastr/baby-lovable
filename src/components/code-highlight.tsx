"use client";

import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

let registered = false;

function ensureLanguages(): void {
  if (registered) {
    return;
  }
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("yaml", yaml);
  registered = true;
}

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  svg: "xml",
};

function languageFromPath(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? filePath;
  const lower = base.toLowerCase();

  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    return "bash";
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }

  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] ?? null;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface CodeHighlightProps {
  code: string;
  filePath: string;
  className?: string;
}

/**
 * Lightweight read-only highlight via highlight.js core + a small language set.
 * Unknown extensions fall back to escaped plain text.
 */
export function CodeHighlight({
  code,
  filePath,
  className = "",
}: CodeHighlightProps) {
  const html = useMemo(() => {
    ensureLanguages();
    const language = languageFromPath(filePath);
    if (!language) {
      return escapeHtml(code);
    }
    try {
      return hljs.highlight(code, {
        language,
        ignoreIllegals: true,
      }).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, filePath]);

  return (
    <pre
      className={`explorer-code m-0 overflow-auto p-3 font-mono text-[12px] leading-5 ${className}`}
    >
      <code
        className="hljs whitespace-pre"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}
