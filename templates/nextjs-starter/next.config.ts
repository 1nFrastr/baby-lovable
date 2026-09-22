import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Preview proxies (Daytona / Vercel Sandbox) hit this dev server from a
  // public hostname. Next.js otherwise treats those asset requests as
  // cross-origin and blocks hydration/HMR, leaving SSR HTML non-interactive
  // (clicks dead, no Next.js N overlay).
  allowedDevOrigins: ["*.daytonaproxy01.net", "*.vercel.run"],
  // This project is generated nested inside the baby-lovable repo, which has
  // its own lockfile. Pin the workspace root to this project so Next.js does
  // not infer the parent repo as the root (avoids the multiple-lockfiles warning
  // and incorrect file tracing).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
