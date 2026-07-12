import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@vercel/oidc", "ajv"],
  logging: {
    incomingRequests: {
      ignore: [/\/api\/sessions\/[^/]+\/preview/],
    },
  },
};

export default withWorkflow(nextConfig);
