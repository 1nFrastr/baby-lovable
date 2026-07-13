import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // playwright-core must stay external so connectOverCDP runs as real Node I/O
  // (WebSocket to Cloudflare Browser Run) rather than a broken bundled stub.
  serverExternalPackages: ["@vercel/oidc", "ajv", "playwright-core"],
  // playwright-core ≥1.60 loads browsers.json via require(path.join(...)), which
  // @vercel/nft cannot follow — Vercel serverless then fails at import with
  // "Cannot find module '.../playwright-core/browsers.json'". Force-include only
  // on routes that actually run Browser Run (Workflow steps + app-test API).
  // @see https://github.com/microsoft/playwright/issues/41248
  outputFileTracingIncludes: {
    "/.well-known/workflow/v1/step": ["./node_modules/playwright-core/**/*"],
    "/api/sessions/*/app-test": ["./node_modules/playwright-core/**/*"],
  },
  logging: {
    incomingRequests: {
      ignore: [/\/api\/sessions\/[^/]+\/preview/],
    },
  },
};

export default withWorkflow(nextConfig);
