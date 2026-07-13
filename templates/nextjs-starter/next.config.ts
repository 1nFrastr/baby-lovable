import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Daytona forwards browser requests from its preview domain to this dev
  // server. Next.js otherwise treats those dev-asset requests as cross-origin
  // and blocks hydration/HMR, leaving the server-rendered UI non-interactive.
  allowedDevOrigins: ["*.daytonaproxy01.net"],
  // This project is generated nested inside the baby-lovable repo, which has
  // its own lockfile. Pin the workspace root to this project so Next.js does
  // not infer the parent repo as the root (avoids the multiple-lockfiles warning
  // and incorrect file tracing).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
