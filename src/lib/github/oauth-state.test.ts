import { afterEach, describe, expect, it } from "vitest";

import {
  buildGithubAppOAuthState,
  decodeGithubAppOAuthState,
} from "./oauth-state";

describe("github oauth state", () => {
  const prev = process.env.GITHUB_APP_CLIENT_SECRET;

  afterEach(() => {
    if (prev === undefined) delete process.env.GITHUB_APP_CLIENT_SECRET;
    else process.env.GITHUB_APP_CLIENT_SECRET = prev;
  });

  it("round-trips signed state", () => {
    process.env.GITHUB_APP_CLIENT_SECRET = "test-secret";
    const encoded = buildGithubAppOAuthState({
      sessionId: "sess_abc",
      userId: "user-1",
      returnTo: "/sessions/sess_abc",
      intent: "oauth",
      redirectUri: "http://localhost:3000/api/github/app/callback",
    });
    const decoded = decodeGithubAppOAuthState(encoded);
    expect(decoded.sessionId).toBe("sess_abc");
    expect(decoded.userId).toBe("user-1");
    expect(decoded.returnTo).toBe("/sessions/sess_abc");
    expect(decoded.intent).toBe("oauth");
    expect(decoded.redirectUri).toBe(
      "http://localhost:3000/api/github/app/callback",
    );
  });

  it("rejects tampered state", () => {
    process.env.GITHUB_APP_CLIENT_SECRET = "test-secret";
    const encoded = buildGithubAppOAuthState({
      sessionId: "sess_abc",
      userId: "user-1",
    });
    expect(() => decodeGithubAppOAuthState(`${encoded}x`)).toThrow();
  });
});
