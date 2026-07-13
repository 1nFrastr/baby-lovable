import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Runtime session data + per-session workspace build output (.next, node_modules).
    ".baby-lovable/**",
    // Workflow DevKit build artifacts (generated route handlers).
    "src/app/.well-known/workflow/**",
  ]),
]);

export default eslintConfig;
