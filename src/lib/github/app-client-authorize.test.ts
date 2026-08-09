import { afterEach, describe, expect, it } from "vitest";

import { buildGithubAppAuthorizeUrl } from "./app-client";

const REQUIRED = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_CLIENT_ID: "Iv1.test-client",
  GITHUB_APP_CLIENT_SECRET: "test-secret",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZGFw=\n-----END RSA PRIVATE KEY-----",
};

describe("buildGithubAppAuthorizeUrl", () => {
  const prev: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of Object.keys(REQUIRED)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    if (prev.NEXT_PUBLIC_APP_URL === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = prev.NEXT_PUBLIC_APP_URL;
    }
    if (prev.GITHUB_APP_INSTALL_URL === undefined) {
      delete process.env.GITHUB_APP_INSTALL_URL;
    } else {
      process.env.GITHUB_APP_INSTALL_URL = prev.GITHUB_APP_INSTALL_URL;
    }
    if (prev.GITHUB_APP_SLUG === undefined) {
      delete process.env.GITHUB_APP_SLUG;
    } else {
      process.env.GITHUB_APP_SLUG = prev.GITHUB_APP_SLUG;
    }
  });

  function stubEnv() {
    for (const [key, value] of Object.entries(REQUIRED)) {
      prev[key] = process.env[key];
      process.env[key] = value;
    }
    prev.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
    prev.GITHUB_APP_INSTALL_URL = process.env.GITHUB_APP_INSTALL_URL;
    prev.GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG;
  }

  it("defaults to installations/new so uninstall can reinstall", () => {
    stubEnv();
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.GITHUB_APP_INSTALL_URL =
      "https://github.com/apps/demo/installations/new";

    const url = new URL(
      buildGithubAppAuthorizeUrl({
        sessionId: "sess_abc",
        userId: "user_1",
        requestOrigin: "http://localhost:3000",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://github.com/apps/demo/installations/new",
    );
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBeNull();
  });

  it("intent=oauth uses authorize with explicit redirect_uri", () => {
    stubEnv();
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.GITHUB_APP_INSTALL_URL =
      "https://github.com/apps/demo/installations/new";

    const url = new URL(
      buildGithubAppAuthorizeUrl({
        sessionId: "sess_abc",
        userId: "user_1",
        requestOrigin: "http://localhost:3000",
        intent: "oauth",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("Iv1.test-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/github/app/callback",
    );
  });

  it("oauth intent prefers NEXT_PUBLIC_APP_URL for redirect_uri", () => {
    stubEnv();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    const url = new URL(
      buildGithubAppAuthorizeUrl({
        sessionId: "sess_abc",
        userId: "user_1",
        requestOrigin: "http://localhost:3000",
        intent: "oauth",
      }),
    );

    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/github/app/callback",
    );
  });
});
