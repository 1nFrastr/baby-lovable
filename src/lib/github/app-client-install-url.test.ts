import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./install-state", () => ({
  buildGithubAppInstallState: () => "signed-install-state",
}));

import { buildGithubAppInstallUrl } from "./app-client";

describe("buildGithubAppInstallUrl", () => {
  const previous = {
    id: process.env.GITHUB_APP_ID,
    key: process.env.GITHUB_APP_PRIVATE_KEY,
    installUrl: process.env.GITHUB_APP_INSTALL_URL,
    slug: process.env.GITHUB_APP_SLUG,
  };

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("GITHUB_APP_ID", previous.id);
    restore("GITHUB_APP_PRIVATE_KEY", previous.key);
    restore("GITHUB_APP_INSTALL_URL", previous.installUrl);
    restore("GITHUB_APP_SLUG", previous.slug);
  });

  function configure() {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  }

  it("adds signed state to the configured installation URL", () => {
    configure();
    process.env.GITHUB_APP_INSTALL_URL =
      "https://github.com/apps/demo/installations/new";
    const url = new URL(
      buildGithubAppInstallUrl({
        sessionId: "sess_abc",
        userId: "user_1",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://github.com/apps/demo/installations/new",
    );
    expect(url.searchParams.get("state")).toBe("signed-install-state");
    expect(url.searchParams.has("redirect_uri")).toBe(false);
  });

  it("uses the app slug when an explicit installation URL is absent", () => {
    configure();
    delete process.env.GITHUB_APP_INSTALL_URL;
    process.env.GITHUB_APP_SLUG = "demo";
    const url = new URL(
      buildGithubAppInstallUrl({
        sessionId: "sess_abc",
        userId: null,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://github.com/apps/demo/installations/new",
    );
  });
});
