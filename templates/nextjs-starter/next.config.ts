import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This project is generated nested inside the baby-lovable repo, which has
  // its own lockfile. Pin the workspace root to this project so Next.js does
  // not infer the parent repo as the root (avoids the multiple-lockfiles warning
  // and incorrect file tracing).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
