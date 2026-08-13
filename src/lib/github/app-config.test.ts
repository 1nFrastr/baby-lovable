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
  const previous = {
    id: process.env.GITHUB_APP_ID,
    key: process.env.GITHUB_APP_PRIVATE_KEY,
    install: process.env.GITHUB_APP_INSTALL_URL,
  };

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("GITHUB_APP_ID", previous.id);
    restore("GITHUB_APP_PRIVATE_KEY", previous.key);
    restore("GITHUB_APP_INSTALL_URL", previous.install);
  });

  it("is false without credentials", () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALL_URL;
    expect(isGithubAppConfigured()).toBe(false);
  });

  it("requires only App credentials and an installation URL", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key";
    process.env.GITHUB_APP_INSTALL_URL =
      "https://github.com/apps/demo/installations/new";
    expect(isGithubAppConfigured()).toBe(true);
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
