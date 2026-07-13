import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getSessionRoot } from "@/lib/sandbox/paths";
import type { UserId } from "@/lib/session/types";

export function createAppTestRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `run_${stamp}`;
}

export function resolveAppTestArtifactDir(
  sessionId: string,
  runId: string,
  userId: UserId = null,
  override?: string,
): string {
  if (override) {
    return path.resolve(override);
  }
  return path.join(getSessionRoot(sessionId, userId), "app-tests", runId);
}

export async function ensureArtifactDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeLiveViewArtifacts(
  artifactDir: string,
  liveViewUrl: string,
): Promise<{ urlPath: string; monitorPath: string }> {
  await ensureArtifactDir(artifactDir);
  const urlPath = path.join(artifactDir, "live-view.url");
  const monitorPath = path.join(artifactDir, "monitor.html");

  await writeFile(urlPath, `${liveViewUrl}\n`, "utf8");
  await writeFile(
    monitorPath,
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0;url=${escapeHtmlAttr(liveViewUrl)}" />
  <title>App Test Live View</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
    a { word-break: break-all; }
  </style>
</head>
<body>
  <h1>App Test Live View</h1>
  <p>Redirecting to Cloudflare Live View…</p>
  <p><a href="${escapeHtmlAttr(liveViewUrl)}">${escapeHtml(liveViewUrl)}</a></p>
</body>
</html>
`,
    "utf8",
  );

  return { urlPath, monitorPath };
}

export async function writeReportJson(
  artifactDir: string,
  report: unknown,
): Promise<string> {
  await ensureArtifactDir(artifactDir);
  const reportPath = path.join(artifactDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}
