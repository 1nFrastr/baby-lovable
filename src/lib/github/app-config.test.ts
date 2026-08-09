import { afterEach, describe, expect, it } from "vitest";

import {
  getGithubAppSlug,
  getPublicAppOrigin,
  isGithubAppConfigured,
  normalizePrivateKeyPem,
} from "./app-config";

describe("normalizePrivateKeyPem", () => {
  it("expands literal \\n escapes", () => {
    const pem = normalizePrivateKeyPem(
      "-----BEGIN RSA PRIVATE KEY-----\\nABC\\n-----END RSA PRIVATE KEY-----",
    );
    expect(pem).toContain("\nABC\n");
    expect(pem).not.toContain("\\n");
  });
});

describe("getGithubAppSlug", () => {
  const prev = {
    slug: process.env.GITHUB_APP_SLUG,
    install: process.env.GITHUB_APP_INSTALL_URL,
  };

  afterEach(() => {
    if (prev.slug === undefined) delete process.env.GITHUB_APP_SLUG;
    else process.env.GITHUB_APP_SLUG = prev.slug;
    if (prev.install === undefined) delete process.env.GITHUB_APP_INSTALL_URL;
    else process.env.GITHUB_APP_INSTALL_URL = prev.install;
  });

  it("reads explicit slug or parses install URL", () => {
    delete process.env.GITHUB_APP_SLUG;
    process.env.GITHUB_APP_INSTALL_URL =
      "https://github.com/apps/git-sync-for-babylovable/installations/new";
    expect(getGithubAppSlug()).toBe("git-sync-for-babylovable");
  });
});

describe("isGithubAppConfigured", () => {
  it("is false without credentials", () => {
    expect(isGithubAppConfigured()).toBe(false);
  });
});

describe("getPublicAppOrigin", () => {
  const prev = {
    vercelUrl: process.env.VERCEL_URL,
  };

  afterEach(() => {
    if (prev.vercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = prev.vercelUrl;
  });

  it("prefers request host", () => {
    process.env.VERCEL_URL = "app.example.com";
    expect(getPublicAppOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });

  it("falls back to VERCEL_URL when request host is omitted", () => {
    process.env.VERCEL_URL = "app.example.com";
    expect(getPublicAppOrigin()).toBe("https://app.example.com");
  });

  it("falls back to localhost without host or VERCEL_URL", () => {
    delete process.env.VERCEL_URL;
    expect(getPublicAppOrigin()).toBe("http://localhost:3000");
  });
});
